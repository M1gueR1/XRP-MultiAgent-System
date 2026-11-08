import type { RobotFleetManager } from "../fleet/RobotFleetManager";
import { MessageExpiredBeforeSendError } from "../fleet/writeScheduler";
import type { PingWriteDiagnostics } from "../fleet/types";
import { LAPTOP_COORDINATOR_ID, MULTI_AGENT_PROTOCOL_VERSION, MultiAgentMessageKind } from "../protocol/constants";
import { decodeRateReport, rateCommand, RATE_TEST_HZ, RATE_TEST_RATES, RATE_TEST_TOPIC, RateTestOp, type RateReceiverReport } from "./rateTestProtocol";

export interface RateSample {
  sequence: number;
  scheduledMs: number;
  attemptedMs?: number;
  finishedMs?: number;
  status: "writing" | "written" | "expired-before-send" | "backpressure" | "receiver-backpressure" | "timer-missed" | "error";
  error?: string;
  diagnostics?: PingWriteDiagnostics;
}

export interface SustainedRateResult {
  version: 2;
  kind: "physical-single-xrp-synthetic-load";
  runId: number;
  robotId: number;
  robotName: string;
  hardwareIdentity?: string;
  sessionId: string;
  startedAt: string;
  finishedAt?: string;
  sendStartedAt?: string;
  sendFinishedAt?: string;
  finalReportTimeoutMs: 20000;
  status: "running" | "complete" | "cancelled" | "error";
  error?: string;
  failurePhase?: string;
  cleanup?: string;
  sessionFailure?: {
    at: string; readySessionIds: string[]; expectedSessionId: string;
    state?: string; transportConnected: boolean; lastHeartbeatAgeMs?: number;
  };
  requestedHz: number;
  durationSeconds: number;
  transport: string;
  uartWithoutResponse: boolean;
  requestedUartChunkSizeBytes: 20 | null;
  automaticPings: "paused";
  intervalVerification: "operator-confirmed-15ms-not-read-by-browser";
  applicationBytes: 12;
  sampleTtlMs: 150;
  maximumUnreportedSamples: 60;
  peakUnreportedSamples: number;
  receiver?: RateReceiverReport;
  receiverSnapshots: { arrivedAt: string; report: RateReceiverReport }[];
  samples: RateSample[];
  summary?: {
    scheduled: number; written: number; expiredBeforeSend: number; skippedBackpressure: number; skippedReceiverBackpressure: number; skippedTimer: number; writeErrors: number;
    missingAtReceiver: number | null; receiverHzOverScheduledWindow: number | null;
  };
}

export interface SustainedRateOptions {
  robotId: number;
  signal: AbortSignal;
  uartWithoutResponse: boolean;
  intervalConfirmed: boolean;
  durationSeconds?: number;
  requestedHz?: number;
  onProgress: (phase: "arming" | "sending" | "draining" | "finishing", fraction: number, receiver?: RateReceiverReport) => void;
}

const activeSessions = new Set<string>();
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export async function runSustainedRateTest(fleet: RobotFleetManager, options: SustainedRateOptions): Promise<SustainedRateResult> {
  const duration = options.durationSeconds ?? 60;
  const hz = options.requestedHz ?? RATE_TEST_HZ;
  if (!RATE_TEST_RATES.some((rate) => rate === hz)) throw new RangeError("Rate must be 5, 10 or 30 Hz.");
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw new RangeError("Duration must be 1 to 60 seconds.");
  if (!options.intervalConfirmed) throw new Error("Confirm the observed 15 ms Windows interval first.");
  const robots = fleet.getReadySessions();
  if (robots.length !== 1 || robots[0].robotId !== options.robotId) throw new Error("30 Hz test requires exactly one ready XRP.");
  const robot = robots[0], transport = robot.transport;
  if (transport.runtimeChannel !== "ble-uart" && transport.runtimeChannel !== "ble-data") throw new Error("A Bluetooth XRP is required; USB is power only.");
  if (options.uartWithoutResponse && (!transport.supportsRuntimeUartWithoutResponse || !transport.useRuntimeUartWithoutResponse || transport.runtimeChannel !== "ble-uart")) {
    throw new Error("UART without-response writes are not available on this XRP.");
  }
  if (activeSessions.has(robot.sessionId)) throw new Error("A rate test is already running on this session.");
  const runId = crypto.getRandomValues(new Uint32Array(1))[0];
  const result: SustainedRateResult = {
    version: 2, kind: "physical-single-xrp-synthetic-load", runId, robotId: options.robotId,
    robotName: robot.alias, hardwareIdentity: robot.hardwareIdentity, sessionId: robot.sessionId,
    startedAt: new Date().toISOString(), finalReportTimeoutMs: 20000,
    status: "running", requestedHz: hz, durationSeconds: duration,
    transport: transport.runtimeChannel, uartWithoutResponse: options.uartWithoutResponse,
    requestedUartChunkSizeBytes: options.uartWithoutResponse ? 20 : null,
    automaticPings: "paused", intervalVerification: "operator-confirmed-15ms-not-read-by-browser", applicationBytes: 12, sampleTtlMs: 150,
    maximumUnreportedSamples: 60, peakUnreportedSamples: 0,
    samples: [], receiverSnapshots: [],
  };
  let unsubscribe: (() => void) | undefined, resume: (() => void) | undefined, restore: (() => void) | undefined;
  let pending = false, writeFailure: string | undefined, receiverProblem: string | undefined;
  let phase = "setup", inFlight = 0, startAttempted = false;
  const unreportedSamples = new Set<number>();
  const sessionRecord = () => typeof fleet.getSessionByRobotId === "function"
    ? fleet.getSessionByRobotId(options.robotId) : robot;
  const sameLink = () => {
    const selected = sessionRecord();
    return selected?.sessionId === result.sessionId && selected.transport === transport
      && selected.robotId === options.robotId
      && (!result.hardwareIdentity || selected.hardwareIdentity === result.hardwareIdentity)
      && transport.isConnected();
  };
  const sessionFailure = (reason: string): never => {
    const selected = sessionRecord();
    const heartbeat = selected?.metrics?.lastHeartbeatAt;
    result.sessionFailure = {
      at: new Date().toISOString(), readySessionIds: fleet.getReadySessions().map((ready) => ready.sessionId),
      expectedSessionId: result.sessionId, state: selected?.state, transportConnected: transport.isConnected(),
      lastHeartbeatAgeMs: heartbeat ? Math.max(0, Date.now() - heartbeat) : undefined,
    };
    throw new Error(`${reason} Phase: ${phase}; state: ${selected?.state ?? "unavailable"}; Bluetooth connected: ${transport.isConnected()}. Export this test JSON.`);
  };
  const current = (allowNotReady = false) => {
    if (options.signal.aborted) throw new Error("Test cancelled.");
    if (typeof document !== "undefined" && document.visibilityState === "hidden") throw new Error("Browser tab was hidden. The timed test is incomplete.");
    const ready = fleet.getReadySessions();
    if (!sameLink()) sessionFailure("Bluetooth link disconnected or the selected session was replaced.");
    if (ready.some((entry) => entry.sessionId !== result.sessionId || entry.robotId !== options.robotId)) sessionFailure("Another ready XRP appeared.");
    if (!allowNotReady && (ready.length !== 1 || ready[0].sessionId !== result.sessionId)) sessionFailure("XRP runtime is no longer ready; this is not necessarily a Bluetooth disconnect.");
    if (writeFailure) throw new Error(writeFailure);
    if (receiverProblem) throw new Error(receiverProblem);
  };
  const write = (op: number, value = 0, diagnostics?: PingWriteDiagnostics) => {
    const promise = robot.send({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION, messageKind: MultiAgentMessageKind.DATA,
      flags: 0, sourceRobotId: LAPTOP_COORDINATOR_ID, targetRobotId: options.robotId,
      sequence: robot.nextSequence(), topicId: RATE_TEST_TOPIC, ttlMilliseconds: op === RateTestOp.SAMPLE ? result.sampleTtlMs : 3000,
      applicationPayload: rateCommand(op, runId, value, hz),
    }, diagnostics);
    inFlight++;
    return promise.finally(() => { inFlight--; });
  };
  const send = (op: number, value = 0, diagnostics?: PingWriteDiagnostics) => {
    current(phase.startsWith("arming"));
    return write(op, value, diagnostics);
  };
  const waitFor = async (condition: () => boolean, timeout: number, description: string) => {
    const start = performance.now();
    while (!condition()) {
      current(phase.startsWith("arming"));
      if (performance.now() - start > timeout) throw new Error(`${description} Phase: ${phase}. Export this test JSON.`);
      await sleep();
    }
    current(phase.startsWith("arming"));
  };
  // Control writes remain bounded too; no unbounded wait on a stalled GATT promise.
  const control = async (op: number, value = 0) => {
    let done = false, error: unknown;
    void send(op, value).then(() => { done = true; }, (reason: unknown) => { error = reason; done = true; });
    await waitFor(() => done, 5000, "Bluetooth control write did not finish within 5 seconds.");
    if (error) throw error;
  };
  activeSessions.add(robot.sessionId);
  try {
    current();
    resume = fleet.pauseAutomaticPings(options.robotId);
    if (options.uartWithoutResponse) restore = transport.useRuntimeUartWithoutResponse!(20);
    unsubscribe = fleet.onTopic(RATE_TEST_TOPIC, (message) => {
      if (message.sourceRobotId !== options.robotId || message.targetRobotId !== LAPTOP_COORDINATOR_ID) return;
      const data = message.applicationPayload;
      if (data.length === 6 && data[0] === 1 && data[1] === RateTestOp.BUSY
        && new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, true) === runId) {
        receiverProblem = "Receiver is still measuring a previous run. Wait for it to finish, or stop and rerun ble_30hz_receiver.py before restarting the Windows helper.";
        return;
      }
      const report = decodeRateReport(message.applicationPayload);
      if (!report || report.runId !== runId || report.received > duration * hz) return;
      if (result.receiver?.phase === "final" || (result.receiver && report.received < result.receiver.received)) return;
      result.receiver = report;
      if (report.lastSequence !== null) {
        // A progress frontier, not an ACK for every older packet. Loss is still
        // measured from the final unique count, never inferred from this watermark.
        for (const sequence of unreportedSamples) if (sequence <= report.lastSequence) unreportedSamples.delete(sequence);
      }
      if (result.receiverSnapshots.length < 100) result.receiverSnapshots.push({ arrivedAt: new Date().toISOString(), report });
    });
    phase = "arming-runtime";
    options.onProgress("arming", 0);
    await waitFor(() => fleet.getReadySessions().length === 1, 8000, "XRP runtime did not become ready during setup.");
    phase = "arming-control";
    startAttempted = true;
    await control(RateTestOp.START, duration);
    phase = "arming-receiver";
    await waitFor(() => result.receiver?.phase === "armed", 8000, "Receiver did not confirm START. It may be busy, stopped, or not receiving the test topic; RATE_TEST_READY alone is not the START confirmation.");
    phase = "arming-runtime";
    await waitFor(() => fleet.getReadySessions().length === 1, 8000, "XRP runtime stopped being ready during setup.");
    phase = "sending";
    const start = performance.now(), total = duration * hz, period = 1000 / hz;
    result.sendStartedAt = new Date().toISOString();
    let slot = 0, nextProgress = 0;
    while (slot < total) {
      current();
      const elapsed = performance.now() - start;
      if (elapsed >= nextProgress) {
        options.onProgress("sending", Math.min(1, elapsed / (duration * 1000)), result.receiver);
        nextProgress = elapsed + 250;
      }
      if (elapsed < slot * period) { await sleep(); continue; }
      // Absolute slots prevent drift; late slots are counted, never replayed in a burst.
      const due = Math.min(total - 1, Math.floor(elapsed / period));
      while (slot < due) result.samples.push({ sequence: slot, scheduledMs: slot++ * period, status: "timer-missed" });
      if (elapsed >= duration * 1000) {
        result.samples.push({ sequence: slot, scheduledMs: slot++ * period, status: "timer-missed" });
        continue;
      }
      const status: RateSample["status"] = pending ? "backpressure"
        : unreportedSamples.size >= result.maximumUnreportedSamples ? "receiver-backpressure" : "writing";
      const sample: RateSample = { sequence: slot, scheduledMs: slot * period, status };
      result.samples.push(sample);
      slot++;
      if (status === "writing") {
        pending = true;
        unreportedSamples.add(sample.sequence);
        result.peakUnreportedSamples = Math.max(result.peakUnreportedSamples, unreportedSamples.size);
        sample.attemptedMs = elapsed;
        sample.diagnostics = { channel: transport.runtimeChannel };
        void send(RateTestOp.SAMPLE, sample.sequence, sample.diagnostics).then(() => {
          sample.finishedMs = performance.now() - start;
          sample.status = "written";
        }, (error: unknown) => {
          sample.finishedMs = performance.now() - start;
          sample.error = error instanceof Error ? error.message : String(error);
          if (error instanceof MessageExpiredBeforeSendError) {
            // The transport was never called. Record the missed deadline without
            // retrying stale data or aborting the remaining measurement window.
            sample.status = "expired-before-send";
            unreportedSamples.delete(sample.sequence);
            return;
          }
          sample.status = "error";
          writeFailure = sample.error;
        }).finally(() => { pending = false; });
      }
      await sleep();
    }
    // Keep the full nominal window even when the last slot finished early.
    await waitFor(() => performance.now() - start >= duration * 1000, 1000, "Send-window timer did not finish.");
    result.sendFinishedAt = new Date().toISOString();
    phase = "draining";
    options.onProgress("draining", 1, result.receiver);
    await waitFor(() => !pending, 5000, "The last sample write did not finish within 5 seconds.");
    // Allow in-flight radio data to drain before requesting the final receiver counters.
    const drainStarted = performance.now();
    await waitFor(() => performance.now() - drainStarted >= 2000, 3000, "Drain timer did not finish.");
    phase = "finishing";
    options.onProgress("finishing", 1, result.receiver);
    await control(RateTestOp.STOP);
    // STOP shares the UART queue with samples. Wait beyond the receiver's
    // duration + 15 s auto-finalization, without extending the measurement window.
    await waitFor(() => result.receiver?.phase === "final", result.finalReportTimeoutMs, "Receiver did not return its final counters within the bounded closing window.");
    result.status = "complete";
  } catch (error) {
    result.status = options.signal.aborted ? "cancelled" : "error";
    result.error = error instanceof Error ? error.message : String(error);
    result.failurePhase = phase;
  } finally {
    if (startAttempted && result.status !== "complete") {
      result.cleanup = "not-sent-link-unavailable";
      // Cancel only this run on the original link, even after user cancellation
      // or a fleet heartbeat error. Never reconnect, reset, or queue behind a hung write.
      const deadline = performance.now() + 2000;
      try {
        while (inFlight && sameLink() && performance.now() < deadline) await sleep();
        if (sameLink() && !inFlight) {
          let settled = false;
          result.cleanup = "cancel-pending";
          void write(RateTestOp.CANCEL).then(() => {
            result.cleanup = "cancel-write-completed"; settled = true;
          }, () => { result.cleanup = "cancel-write-failed"; settled = true; });
          while (!settled && sameLink() && performance.now() < deadline) await sleep();
          while (settled && result.receiver?.phase !== "final" && sameLink() && performance.now() < deadline) await sleep();
          if (result.receiver?.phase === "final") result.cleanup = "receiver-cancel-confirmed";
        } else if (inFlight) result.cleanup = "not-sent-write-still-pending";
      } catch { result.cleanup = "cancel-failed"; }
    }
    unsubscribe?.();
    try { restore?.(); } finally { resume?.(); activeSessions.delete(robot.sessionId); }
    result.finishedAt = new Date().toISOString();
    const count = (status: RateSample["status"]) => result.samples.filter((sample) => sample.status === status).length;
    const written = count("written");
    result.summary = {
      scheduled: duration * hz, written, expiredBeforeSend: count("expired-before-send"), skippedBackpressure: count("backpressure"),
      skippedReceiverBackpressure: count("receiver-backpressure"), skippedTimer: count("timer-missed"),
      writeErrors: count("error"), missingAtReceiver: result.status === "complete" && result.receiver ? Math.max(0, written - result.receiver.received) : null,
      receiverHzOverScheduledWindow: result.status === "complete" && result.receiver ? result.receiver.withinWindow / duration : null,
    };
  }
  // Late OS completions must not mutate an already-exportable partial report.
  return { ...result, receiverSnapshots: [...result.receiverSnapshots], samples: result.samples.map((sample) => ({
    ...sample, diagnostics: sample.diagnostics ? { ...sample.diagnostics } : undefined,
  })) };
}
