import { MultiAgentTopic } from "../protocol/constants";
import type { RobotFleetManager } from "../fleet/RobotFleetManager";

export interface BenchmarkRobotResult {
  robotId: number;
  messagesSent: number;
  messagesReceived: number;
  actualSendsPerSecond: number;
  actualReceivesPerSecond: number;
  dropped: number;
  coalesced: number;
  stale: number;
  maximumQueueDepth: number;
  rttP50Ms: number | null;
  rttP95Ms: number | null;
  rttP99Ms: number | null;
  reconnects: number;
  disconnects: number;
}

export interface FleetBenchmarkResult {
  kind: "simulated" | "physical";
  startedAt: string;
  durationMs: number;
  requestedFrequencyHz: number;
  robotsConnected: number;
  attemptedMessages: number;
  actualAttemptsPerSecond: number;
  robots: BenchmarkRobotResult[];
}

export class FleetBenchmark {
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private startedIso = "";
  private attemptedMessages = 0;
  private frequencyHz = 20;
  private readonly baselines = new Map<number, {
    sent: number;
    received: number;
    dropped: number;
    coalesced: number;
    stale: number;
    reconnects: number;
    disconnects: number;
  }>();

  constructor(private readonly fleet: RobotFleetManager) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(frequencyHz = 20): void {
    if (this.running) throw new Error("Benchmark is already running.");
    if (frequencyHz < 10 || frequencyHz > 25) {
      throw new RangeError("Benchmark frequency must be between 10 and 25 Hz.");
    }
    this.frequencyHz = frequencyHz;
    this.startedAt = performance.now();
    this.startedIso = new Date().toISOString();
    this.attemptedMessages = 0;
    this.baselines.clear();
    for (const session of this.fleet.getSessions()) {
      if (session.robotId === undefined) continue;
      this.baselines.set(session.robotId, {
        sent: session.metrics.messagesSent,
        received: session.metrics.messagesReceived,
        dropped: session.metrics.messagesDropped,
        coalesced: session.metrics.messagesCoalesced,
        stale: session.metrics.stalePackets,
        reconnects: session.metrics.reconnectCount,
        disconnects: session.metrics.disconnectCount,
      });
    }
    let counter = 0;
    this.timer = setInterval(() => {
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, counter++, true);
      for (const session of this.fleet.getReadySessions()) {
        this.attemptedMessages += 1;
        void this.fleet.publish({
          targetRobotId: session.robotId!,
          topicId: MultiAgentTopic.ROBOT_STATUS,
          payload,
          qos: "latest",
          ttlMs: Math.max(100, Math.round(2000 / this.frequencyHz)),
        }).catch(() => undefined);
      }
    }, 1000 / frequencyHz);
  }

  stop(kind: "simulated" | "physical" = "physical"): FleetBenchmarkResult {
    if (this.timer === undefined) throw new Error("Benchmark is not running.");
    clearInterval(this.timer);
    this.timer = undefined;
    const durationMs = performance.now() - this.startedAt;
    const sessions = this.fleet.getSessions().filter((session) => session.robotId !== undefined);
    const seconds = durationMs / 1000;
    return {
      kind,
      startedAt: this.startedIso,
      durationMs,
      requestedFrequencyHz: this.frequencyHz,
      robotsConnected: this.fleet.getReadySessions().length,
      attemptedMessages: this.attemptedMessages,
      actualAttemptsPerSecond: durationMs > 0 ? this.attemptedMessages / (durationMs / 1000) : 0,
      robots: sessions.map((session) => {
        const baseline = this.baselines.get(session.robotId!) ?? {
          sent: 0,
          received: 0,
          dropped: 0,
          coalesced: 0,
          stale: 0,
          reconnects: 0,
          disconnects: 0,
        };
        const sent = session.metrics.messagesSent - baseline.sent;
        const received = session.metrics.messagesReceived - baseline.received;
        return {
          robotId: session.robotId!,
          messagesSent: sent,
          messagesReceived: received,
          actualSendsPerSecond: seconds > 0 ? sent / seconds : 0,
          actualReceivesPerSecond: seconds > 0 ? received / seconds : 0,
          dropped: session.metrics.messagesDropped - baseline.dropped,
          coalesced: session.metrics.messagesCoalesced - baseline.coalesced,
          stale: session.metrics.stalePackets - baseline.stale,
          maximumQueueDepth: session.metrics.maximumQueueDepth,
          rttP50Ms: session.metrics.rttP50Ms,
          rttP95Ms: session.metrics.rttP95Ms,
          rttP99Ms: session.metrics.rttP99Ms,
          reconnects: session.metrics.reconnectCount - baseline.reconnects,
          disconnects: session.metrics.disconnectCount - baseline.disconnects,
        };
      }),
    };
  }
}
