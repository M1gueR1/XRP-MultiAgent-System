import type { RobotSessionMetrics } from "./types";

export function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createSessionMetrics(): RobotSessionMetrics {
  return {
    lastReceivedAt: 0,
    lastSentAt: 0,
    lastHeartbeatAt: 0,
    lastPongAt: 0,
    latestRttMs: null,
    averageRttMs: null,
    rttP50Ms: null,
    rttP95Ms: null,
    rttP99Ms: null,
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesDropped: 0,
    messagesCoalesced: 0,
    invalidPackets: 0,
    duplicatePackets: 0,
    stalePackets: 0,
    reconnectCount: 0,
    disconnectCount: 0,
    outgoingQueueDepth: 0,
    maximumQueueDepth: 0,
  };
}

export class RttTracker {
  private readonly samples: number[] = [];

  constructor(private readonly maximumSamples = 256) {}

  add(value: number, metrics: RobotSessionMetrics): void {
    this.samples.push(value);
    if (this.samples.length > this.maximumSamples) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (fraction: number): number | null => {
      if (sorted.length === 0) return null;
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    };
    metrics.latestRttMs = value;
    metrics.averageRttMs = this.samples.reduce((sum, sample) => sum + sample, 0) / this.samples.length;
    metrics.rttP50Ms = percentile(0.5);
    metrics.rttP95Ms = sorted.length >= 5 ? percentile(0.95) : null;
    metrics.rttP99Ms = sorted.length >= 20 ? percentile(0.99) : null;
    metrics.lastPongAt = Date.now();
  }
}
