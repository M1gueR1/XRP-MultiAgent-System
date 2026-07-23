import { XppMessageType } from "../protocol/constants";
import type { RobotCapabilities } from "../protocol/capabilities";
import type { MultiAgentMessage } from "../protocol/message";
import { decodeMultiAgentMessage, decodeXppPacket } from "../protocol/message";
import { XppStreamParser } from "../protocol/streamParser";
import type { RobotTransport } from "../transport/RobotTransport";
import { createSessionMetrics } from "./metrics";
import type {
  RobotHealth,
  RobotSessionContract,
  RobotSessionMetrics,
  RobotSessionState,
} from "./types";
import { RobotWriteScheduler } from "./writeScheduler";

export interface RobotSessionCallbacks {
  onMessage: (session: RobotSession, message: MultiAgentMessage, arrivedAt: number) => void;
  onStateChanged: (session: RobotSession) => void;
}

export class RobotSession implements RobotSessionContract {
  robotId?: number;
  hardwareIdentity?: string;
  state: RobotSessionState = "disconnected";
  capabilities?: RobotCapabilities;
  readonly metrics: RobotSessionMetrics = createSessionMetrics();
  private sequence = 0;
  private readonly parser = new XppStreamParser();
  private scheduler: RobotWriteScheduler;
  private hasConnected = false;
  private readonly removeDataListener: () => void;
  private readonly removeDisconnectedListener: () => void;

  constructor(
    readonly sessionId: string,
    public alias: string,
    readonly transport: RobotTransport,
    private readonly callbacks: RobotSessionCallbacks,
  ) {
    this.scheduler = new RobotWriteScheduler(transport, this.metrics);
    this.removeDataListener = transport.onData((data) => this.handleData(data));
    this.removeDisconnectedListener = transport.onDisconnected(() => this.handleDisconnected());
  }

  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "handshaking" || this.state === "ready") return;
    if (this.hasConnected) this.metrics.reconnectCount += 1;
    this.hasConnected = true;
    this.state = this.metrics.reconnectCount > 0 ? "reconnecting" : "connecting";
    this.callbacks.onStateChanged(this);
    this.parser.reset();
    this.scheduler = new RobotWriteScheduler(this.transport, this.metrics);
    try {
      await this.transport.connect();
      this.state = "handshaking";
      this.callbacks.onStateChanged(this);
    } catch (error) {
      this.state = "error";
      this.callbacks.onStateChanged(this);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.scheduler.stop();
    await this.transport.disconnect();
    this.state = "disconnected";
    this.callbacks.onStateChanged(this);
  }

  dispose(): void {
    this.scheduler.stop();
    this.removeDataListener();
    this.removeDisconnectedListener();
    this.transport.dispose?.();
  }

  markReady(
    robotId: number,
    capabilities: RobotCapabilities,
  ): void {
    this.robotId = robotId;
    this.hardwareIdentity = capabilities.hardwareIdentity;
    this.capabilities = capabilities;
    this.state = "ready";
    this.callbacks.onStateChanged(this);
  }

  markError(): void {
    this.state = "error";
    this.callbacks.onStateChanged(this);
  }

  /** Starts a fresh program-level handshake without closing the physical IDE connection. */
  prepareForRuntimeRestart(): void {
    this.scheduler.stop();
    this.parser.reset();
    this.scheduler = new RobotWriteScheduler(this.transport, this.metrics);
    this.metrics.lastHeartbeatAt = 0;
    this.state = "handshaking";
    this.callbacks.onStateChanged(this);
  }

  nextSequence(): number {
    const result = this.sequence;
    this.sequence = (this.sequence + 1) & 0xffff;
    return result;
  }

  send(message: MultiAgentMessage): Promise<void> {
    if (!this.transport.isConnected()) return Promise.reject(new Error("Robot session is not connected."));
    return this.scheduler.enqueue(message);
  }

  acknowledge(sourceRobotId: number, sequence: number): boolean {
    return this.scheduler.acknowledge(sourceRobotId, sequence);
  }

  getHealth(now = Date.now()): RobotHealth {
    if (this.state !== "ready") return "offline";
    if (this.metrics.lastReceivedAt === 0) return "degraded";
    const elapsed = now - this.metrics.lastReceivedAt;
    if (elapsed > 6000) return "offline";
    if (elapsed > 3000) return "degraded";
    return "healthy";
  }

  private handleData(data: Uint8Array): void {
    const arrivedAt = performance.now();
    this.metrics.bytesReceived += data.length;
    this.metrics.lastReceivedAt = Date.now();
    const result = this.parser.push(data);
    this.metrics.invalidPackets += result.malformedPackets + (result.overflowed ? 1 : 0);
    for (const packetBytes of result.packets) {
      try {
        const packet = decodeXppPacket(packetBytes);
        if (packet.messageType !== XppMessageType.MULTI_AGENT) continue;
        const message = decodeMultiAgentMessage(packet.payload);
        this.metrics.messagesReceived += 1;
        this.callbacks.onMessage(this, message, arrivedAt);
      } catch {
        this.metrics.invalidPackets += 1;
      }
    }
    this.callbacks.onStateChanged(this);
  }

  private handleDisconnected(): void {
    this.metrics.disconnectCount += 1;
    this.scheduler.stop();
    this.state = "disconnected";
    this.callbacks.onStateChanged(this);
  }
}
