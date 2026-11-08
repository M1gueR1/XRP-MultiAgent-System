import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RobotFleetManager } from "../fleet/RobotFleetManager";
import type { MultiAgentMessage } from "../protocol/message";
import { runSustainedRateTest } from "../benchmark/SustainedRateTest";
import { MessageExpiredBeforeSendError } from "../fleet/writeScheduler";
import { decodeRateReport, RATE_DIAGNOSTIC_KEYS, RATE_TEST_TOPIC, rateCommand, RateTestOp } from "../benchmark/rateTestProtocol";

function report(runId: number, phase: number, received = 0, lastSequence = received - 1): Uint8Array {
  const bytes = new Uint8Array(35), view = new DataView(bytes.buffer);
  bytes[0] = 1; bytes[1] = 4; view.setUint32(2, runId, true); bytes[6] = phase;
  view.setUint16(7, received, true); view.setUint16(9, received, true);
  view.setUint16(17, received ? lastSequence : 65535, true);
  view.setUint32(19, 1000, true); view.setUint16(31, phase === 3 ? 34 : 65535, true);
  return bytes;
}

function fixture(writeMs = 5, progressReports = true, finalReportDelayMs = 0) {
  let listener: ((message: MultiAgentMessage) => void) | undefined;
  let sequence = 0, received = 0, runId = 0, active = 0, maximumActive = 0;
  let lastReport = 0, lastSample = 0;
  const restore = vi.fn(), resume = vi.fn(), unsubscribe = vi.fn(() => { listener = undefined; });
  const transport = { runtimeChannel: "ble-uart", supportsRuntimeUartWithoutResponse: true,
    useRuntimeUartWithoutResponse: vi.fn(() => restore), isConnected: vi.fn(() => true) };
  const emit = (bytes: Uint8Array, source = 1) => listener?.({
    protocolVersion: 1, messageKind: 16, flags: 0, sourceRobotId: source, targetRobotId: 0,
    sequence: sequence++, topicId: RATE_TEST_TOPIC, ttlMilliseconds: 3000, applicationPayload: bytes,
  });
  const robot = { sessionId: "single", alias: "XRP test", robotId: 1, transport, nextSequence: () => sequence++,
    send: vi.fn(async (message: MultiAgentMessage) => {
      active++; maximumActive = Math.max(active, maximumActive);
      const data = message.applicationPayload, view = new DataView(data.buffer, data.byteOffset);
      runId = view.getUint32(2, true);
      await new Promise((resolve) => setTimeout(resolve, writeMs));
      if (data[1] === RateTestOp.START) { lastReport = Date.now(); emit(report(runId, 1)); }
      if (data[1] === RateTestOp.SAMPLE) {
        received++; lastSample = view.getUint16(6, true);
        if (progressReports && Date.now() - lastReport >= 800) {
          emit(report(runId, 2, received, lastSample)); lastReport = Date.now();
        }
      }
      if (data[1] === RateTestOp.STOP || data[1] === RateTestOp.CANCEL) {
        if (finalReportDelayMs === 0) emit(report(runId, 3, received, lastSample));
        else if (finalReportDelayMs > 0) setTimeout(() => emit(report(runId, 3, received, lastSample)), finalReportDelayMs);
      }
      active--;
    }),
  };
  const fleet = { getReadySessions: vi.fn(() => [robot]), pauseAutomaticPings: vi.fn(() => resume),
    onTopic: vi.fn((_topic: number, callback: typeof listener) => { listener = callback; return unsubscribe; }) };
  const controller = new AbortController();
  const options = { robotId: 1, signal: controller.signal, intervalConfirmed: true, uartWithoutResponse: true,
    durationSeconds: 1, onProgress: vi.fn() };
  return { robot, fleet, manager: fleet as unknown as RobotFleetManager, options, controller,
    restore, resume, unsubscribe, emit, maxActive: () => maximumActive };
}

describe("bounded single-XRP 30 Hz experiment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("records a queued sample expiry and continues the full 5 Hz window without retrying it", async () => {
    const f = fixture();
    const original = f.robot.send.getMockImplementation()!;
    f.robot.send.mockImplementation(async (message) => {
      const data = message.applicationPayload;
      if (data[1] === RateTestOp.SAMPLE && new DataView(data.buffer, data.byteOffset).getUint16(6, true) === 2) {
        await new Promise((resolve) => setTimeout(resolve, 375));
        throw new MessageExpiredBeforeSendError();
      }
      return original(message);
    });
    const pending = runSustainedRateTest(f.manager, { ...f.options, requestedHz: 5 });
    await vi.advanceTimersByTimeAsync(6500);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.sampleTtlMs).toBe(150);
    expect(result.summary).toMatchObject({ scheduled: 5, written: 3, expiredBeforeSend: 1,
      skippedBackpressure: 1, writeErrors: 0, missingAtReceiver: 0, receiverHzOverScheduledWindow: 3 });
    expect(result.samples[2]).toMatchObject({ status: "expired-before-send", finishedMs: expect.any(Number) });
    expect(f.robot.send.mock.calls.filter(([message]) => message.applicationPayload[1] === RateTestOp.SAMPLE
      && new DataView(message.applicationPayload.buffer).getUint16(6, true) === 2)).toHaveLength(1);
  });

  it.each([5, 10])("schedules %i Hz and communicates the rate to the receiver", async (hz) => {
    const f = fixture();
    const pending = runSustainedRateTest(f.manager, { ...f.options, requestedHz: hz });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.requestedHz).toBe(hz);
    expect(result.summary).toMatchObject({ scheduled: hz, written: hz, receiverHzOverScheduledWindow: hz });
    const start = f.robot.send.mock.calls[0][0].applicationPayload;
    expect(new DataView(start.buffer).getUint16(6, true)).toBe(hz);
    expect(result.samples[1].scheduledMs).toBe(1000 / hz);
  });

  it("decodes extended final diagnostics without changing ordinary report support", () => {
    const bytes = new Uint8Array(35 + RATE_DIAGNOSTIC_KEYS.length * 4);
    bytes.set(report(8, 3, 5));
    const view = new DataView(bytes.buffer);
    RATE_DIAGNOSTIC_KEYS.forEach((_key, i) => view.setUint32(35 + i * 4, 100 + i, true));
    expect(decodeRateReport(bytes)?.diagnostics).toMatchObject({ streamBytes: 100, writeUs: 112 });
    bytes[6] = 2;
    expect(decodeRateReport(bytes)).toBeUndefined();
  });

  it("records revision 6 reader identity in progress and frozen diagnostic reports", () => {
    for (const phase of [1, 2, 3]) {
      const size = phase === 3 ? 89 : 37;
      const bytes = new Uint8Array(size);
      bytes.set(report(8, phase));
      bytes[size - 2] = 6; bytes[size - 1] = 1;
      expect(decodeRateReport(bytes)).toMatchObject({ receiverRevision: 6, readerMode: "ble-uart-buffered-32" });
      expect(!!decodeRateReport(bytes)?.diagnostics).toBe(phase === 3);
      bytes[size - 1] = 9;
      expect(decodeRateReport(bytes)).toBeUndefined();
      bytes[size - 1] = 0; bytes[size - 2] = 7;
      expect(decodeRateReport(bytes)).toBeUndefined();
    }
  });

  it("uses an isolated neutral payload and rejects malformed receiver reports", () => {
    const data = rateCommand(RateTestOp.SAMPLE, 123, 9);
    expect([...data.slice(8)]).toEqual([0, 0, 0, 0]);
    expect(data.length).toBe(12);
    expect(decodeRateReport(new Uint8Array(34))).toBeUndefined();
    const bad = report(3, 9); expect(decodeRateReport(bad)).toBeUndefined();
    const inconsistent = report(3, 3, 30); inconsistent[9] = 29;
    expect(decodeRateReport(inconsistent)).toBeUndefined();
    expect(decodeRateReport(report(3, 3, 30))?.received).toBe(30);
  });

  it("sends 30 absolute slots without per-message replies and restores both leases", async () => {
    const f = fixture();
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.summary).toMatchObject({ scheduled: 30, written: 30, skippedBackpressure: 0,
      skippedTimer: 0, missingAtReceiver: 0, receiverHzOverScheduledWindow: 30 });
    expect(result.samples.map((sample) => sample.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(result.samples.every((sample) => sample.diagnostics !== undefined)).toBe(true);
    expect(f.maxActive()).toBe(1);
    expect(f.robot.send.mock.calls.every(([message]) => message.topicId === RATE_TEST_TOPIC && message.flags === 0)).toBe(true);
    expect(f.restore).toHaveBeenCalledOnce(); expect(f.resume).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("counts backpressure rather than queuing stale commands or claiming 30 Hz", async () => {
    const f = fixture(75);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6500);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.summary!.written).toBeLessThan(30);
    expect(result.summary!.skippedBackpressure).toBeGreaterThan(0);
    expect(result.summary!.receiverHzOverScheduledWindow).toBeLessThan(30);
    expect(f.maxActive()).toBe(1);
    expect(result.samples).toHaveLength(30);
  });

  it("caps completed-but-unreported writes instead of flooding the receiver indefinitely", async () => {
    const f = fixture(5, false);
    const pending = runSustainedRateTest(f.manager, { ...f.options, durationSeconds: 3 });
    await vi.advanceTimersByTimeAsync(8000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.peakUnreportedSamples).toBe(60);
    expect(result.summary).toMatchObject({ written: 60, skippedReceiverBackpressure: 30, receiverHzOverScheduledWindow: 20 });
    expect(result.samples).toHaveLength(90);
  });

  it("resumes after a receiver frontier advances without replaying skipped slots", async () => {
    const f = fixture(5, false);
    const pending = runSustainedRateTest(f.manager, { ...f.options, durationSeconds: 4 });
    setTimeout(() => {
      const data = f.robot.send.mock.calls[0][0].applicationPayload;
      const token = new DataView(data.buffer, data.byteOffset).getUint32(2, true);
      f.emit(report(token, 2, 60, 59));
    }, 2200);
    await vi.advanceTimersByTimeAsync(9000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.summary!.skippedReceiverBackpressure).toBeGreaterThan(0);
    expect(result.summary!.written).toBeGreaterThan(60);
    expect(result.peakUnreportedSamples).toBeLessThanOrEqual(60);
    expect(result.samples).toHaveLength(120);
  });

  it("keeps all 1800 slots in the complete 60-second synthetic test", async () => {
    const f = fixture();
    const pending = runSustainedRateTest(f.manager, { ...f.options, durationSeconds: 60 });
    await vi.advanceTimersByTimeAsync(65000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.samples).toHaveLength(1800);
    expect(result.summary).toMatchObject({ scheduled: 1800, written: 1800, missingAtReceiver: 0, receiverHzOverScheduledWindow: 30 });
    expect(f.maxActive()).toBe(1);
  });

  it("accepts a delayed final report without extending the sample window", async () => {
    const f = fixture(5, true, 15000);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(22000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.samples).toHaveLength(30);
    expect(result.finalReportTimeoutMs).toBe(20000);
    expect(Date.parse(result.sendFinishedAt!) - Date.parse(result.sendStartedAt!)).toBeLessThan(1050);
    expect(Date.parse(result.finishedAt!) - Date.parse(result.sendFinishedAt!)).toBeGreaterThan(15000);
  });

  it("waits for the receiver's independent auto-finalization when STOP has not arrived", async () => {
    const f = fixture(5, true, -1);
    const pending = runSustainedRateTest(f.manager, f.options);
    setTimeout(() => {
      const data = f.robot.send.mock.calls[0][0].applicationPayload;
      const token = new DataView(data.buffer, data.byteOffset).getUint32(2, true);
      f.emit(report(token, 3, 30));
    }, 16020);
    await vi.advanceTimersByTimeAsync(22000);
    const result = await pending;
    expect(result.status).toBe("complete");
    expect(result.summary!.written).toBe(30);
    expect(result.receiver?.phase).toBe("final");
  });

  it("never promotes periodic receiving counters to a final report on timeout", async () => {
    const f = fixture(5, true, -1);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(30000);
    const result = await pending;
    expect(result.status).toBe("error");
    expect(result.failurePhase).toBe("finishing");
    expect(result.receiver?.phase).toBe("receiving");
    expect(result.summary!.receiverHzOverScheduledWindow).toBeNull();
    expect(result.error).toContain("closing window");
  });

  it("refuses a concurrent rate run on the same physical session", async () => {
    const f = fixture();
    const pending = runSustainedRateTest(f.manager, f.options);
    await expect(runSustainedRateTest(f.manager, f.options)).rejects.toThrow("already running");
    f.controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe("cancelled");
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it("counts missed browser slots and never catches up by bursting all old slots", async () => {
    const f = fixture();
    let offset = 0;
    vi.mocked(performance.now).mockImplementation(() => Date.now() + offset);
    setTimeout(() => { offset = 240; }, 150);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.summary!.skippedTimer).toBeGreaterThan(0);
    expect(result.samples).toHaveLength(30);
    expect(f.maxActive()).toBe(1);
  });

  it.each(["cancel", "disconnect", "hidden", "write-error"])("preserves partial data and cleans up on %s", async (reason) => {
    const f = fixture();
    const pending = runSustainedRateTest(f.manager, f.options);
    setTimeout(() => {
      if (reason === "cancel") f.controller.abort();
      if (reason === "disconnect") f.robot.transport.isConnected.mockReturnValue(false);
      if (reason === "hidden") vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      if (reason === "write-error") f.robot.send.mockRejectedValue(new Error("GATT write failed"));
    }, 200);
    await vi.advanceTimersByTimeAsync(6500);
    const result = await pending;
    expect(result.status).toBe(reason === "cancel" ? "cancelled" : "error");
    expect(result.summary!.receiverHzOverScheduledWindow).toBeNull();
    expect(result.samples.length).toBeGreaterThan(0);
    expect(f.restore).toHaveBeenCalledOnce(); expect(f.resume).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not transmit samples before a matching receiver READY report", async () => {
    const f = fixture();
    f.robot.send.mockImplementation(async () => { f.emit(report(999999, 1), 2); });
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(14000);
    const result = await pending;
    expect(result.status).toBe("error"); expect(result.samples).toHaveLength(0);
    expect(f.robot.send.mock.calls.filter(([message]) => message.applicationPayload[1] === RateTestOp.SAMPLE)).toHaveLength(0);
    expect(f.restore).toHaveBeenCalledOnce();
  });

  it("accepts fresh session views when their stable ID and transport still match", async () => {
    const f = fixture();
    f.fleet.getReadySessions.mockImplementation(() => [{ ...f.robot }]);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await pending).status).toBe("complete");
  });

  it("records the heartbeat/runtime failure and cancels without disabling health checks", async () => {
    const f = fixture();
    const canonical = Object.assign(f.robot, { state: "ready", metrics: { lastHeartbeatAt: Date.now() - 3001 } });
    Object.assign(f.fleet, { getSessionByRobotId: () => canonical });
    setTimeout(() => { canonical.state = "error"; f.fleet.getReadySessions.mockReturnValue([]); }, 350);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.error).toContain("runtime is no longer ready");
    expect(result.failurePhase).toBe("sending");
    expect(result.sessionFailure).toMatchObject({ state: "error", transportConnected: true });
    expect(result.cleanup).toBe("receiver-cancel-confirmed");
    expect(canonical.state).toBe("error");
  });

  it("releases the receiver reservation when the user cancels after START", async () => {
    const f = fixture();
    const pending = runSustainedRateTest(f.manager, f.options);
    setTimeout(() => f.controller.abort(), 200);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.cleanup).toBe("receiver-cancel-confirmed");
    expect(f.robot.send.mock.calls.some(([message]) => message.applicationPayload[1] === RateTestOp.CANCEL)).toBe(true);
  });

  it("reports BUSY explicitly rather than recommending to rerun an already-running receiver", async () => {
    const f = fixture();
    f.robot.send.mockImplementation(async (message) => {
      const data = message.applicationPayload;
      if (data[1] === RateTestOp.START) {
        const busy = data.slice(0, 6); busy[1] = RateTestOp.BUSY; f.emit(busy);
      }
    });
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await pending).error).toContain("previous run");
  });

  it("does not send cleanup to a replacement transport", async () => {
    const f = fixture();
    let selected = f.robot;
    Object.assign(f.fleet, { getSessionByRobotId: () => selected });
    const pending = runSustainedRateTest(f.manager, f.options);
    setTimeout(() => { selected = { ...f.robot, transport: { ...f.robot.transport } }; }, 150);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.error).toContain("replaced");
    expect(result.cleanup).toBe("not-sent-link-unavailable");
    expect(f.robot.send.mock.calls.some(([message]) => message.applicationPayload[1] === RateTestOp.CANCEL)).toBe(false);
  });

  it("times out a stalled write and releases settings without waiting forever", async () => {
    const f = fixture();
    f.robot.send.mockImplementation(() => new Promise(() => undefined));
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(9000);
    expect((await pending).status).toBe("error");
    expect(f.resume).toHaveBeenCalledOnce(); expect(f.restore).toHaveBeenCalledOnce();
  });

  it("waits for transient setup readiness without accepting a session loss during measurement", async () => {
    const f = fixture();
    setTimeout(() => f.fleet.getReadySessions.mockReturnValue([]), 2);
    setTimeout(() => f.fleet.getReadySessions.mockReturnValue([f.robot]), 100);
    const pending = runSustainedRateTest(f.manager, f.options);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await pending).status).toBe("complete");
  });

  it("keeps an exported partial report stable when an old OS write completes late", async () => {
    const f = fixture(200);
    const pending = runSustainedRateTest(f.manager, f.options);
    setTimeout(() => f.robot.transport.isConnected.mockReturnValue(false), 250);
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    const saved = JSON.stringify(result);
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(result)).toBe(saved);
    expect(result.samples.some((sample) => sample.status === "writing")).toBe(true);
    expect(result.summary!.written).toBe(0);
  });

  it("rejects bad configuration before pausing or writing", async () => {
    const f = fixture();
    await expect(runSustainedRateTest(f.manager, { ...f.options, intervalConfirmed: false })).rejects.toThrow("15 ms");
    f.robot.transport.runtimeChannel = "usb";
    await expect(runSustainedRateTest(f.manager, f.options)).rejects.toThrow("Bluetooth");
    expect(f.robot.send).not.toHaveBeenCalled(); expect(f.fleet.pauseAutomaticPings).not.toHaveBeenCalled();
  });
});
