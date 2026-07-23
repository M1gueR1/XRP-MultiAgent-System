import {
  LAPTOP_COORDINATOR_ID,
  MultiAgentFlag,
  MultiAgentMessageKind,
  MULTI_AGENT_PROTOCOL_VERSION,
  UNASSIGNED_ROBOT_ID,
  XppMessageType,
} from "../protocol/constants";
import {
  decodeMultiAgentMessage,
  decodeXppPacket,
  encodeMultiAgentMessage,
  encodeXppPacket,
  type MultiAgentMessage,
} from "../protocol/message";
import { defaultVirtualCapabilities, encodeHelloPayload } from "../protocol/capabilities";
import type { RobotTransport } from "./RobotTransport";

export interface VirtualRobotOptions {
  identity?: string;
  latencyMs?: number;
  maximumFragmentSize?: number;
  packetLossRate?: number;
  delayedAcknowledgementMs?: number;
  disconnectAfterWrites?: number;
  autoHandshake?: boolean;
  autoAcknowledge?: boolean;
}

export class VirtualRobotTransport implements RobotTransport {
  private connected = false;
  private robotId = UNASSIGNED_ROBOT_ID;
  private sequence = 0;
  private writes = 0;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly disconnectedListeners = new Set<() => void>();
  readonly receivedMessages: MultiAgentMessage[] = [];
  readonly identity: string;
  readonly latencyMs: number;
  readonly maximumFragmentSize: number;
  readonly packetLossRate: number;
  readonly delayedAcknowledgementMs: number;
  readonly disconnectAfterWrites?: number;
  readonly autoHandshake: boolean;
  readonly autoAcknowledge: boolean;

  constructor(options: VirtualRobotOptions = {}) {
    this.identity = options.identity ?? `virtual-${Math.random().toString(36).slice(2, 10)}`;
    this.latencyMs = options.latencyMs ?? 0;
    this.maximumFragmentSize = options.maximumFragmentSize ?? Number.POSITIVE_INFINITY;
    this.packetLossRate = options.packetLossRate ?? 0;
    this.delayedAcknowledgementMs = options.delayedAcknowledgementMs ?? 0;
    this.disconnectAfterWrites = options.disconnectAfterWrites;
    this.autoHandshake = options.autoHandshake ?? true;
    this.autoAcknowledge = options.autoAcknowledge ?? true;
  }

  get deviceName(): string {
    return `Virtual XRP ${this.identity}`;
  }

  get browserIdentity(): string {
    return this.identity;
  }

  async connect(): Promise<void> {
    this.connected = true;
    if (this.autoHandshake) {
      setTimeout(() => this.sendHello(), this.latencyMs);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnectedListeners) listener();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async writeData(data: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error("Virtual robot is disconnected.");
    this.writes += 1;
    if (this.disconnectAfterWrites !== undefined && this.writes >= this.disconnectAfterWrites) {
      await this.disconnect();
      throw new Error("Virtual robot disconnected during transmission.");
    }
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const packet = decodeXppPacket(data);
    if (packet.messageType !== XppMessageType.MULTI_AGENT) return;
    const message = decodeMultiAgentMessage(packet.payload);
    this.receivedMessages.push(message);
    if (message.messageKind === MultiAgentMessageKind.HELLO_ACK) {
      this.robotId = new DataView(
        message.applicationPayload.buffer,
        message.applicationPayload.byteOffset,
      ).getUint16(0, true);
      return;
    }
    if (message.messageKind === MultiAgentMessageKind.PING) {
      setTimeout(() => this.emitMessage({
        ...message,
        messageKind: MultiAgentMessageKind.PONG,
        sourceRobotId: this.robotId,
        targetRobotId: LAPTOP_COORDINATOR_ID,
        sequence: this.nextSequence(),
        flags: 0,
      }), this.latencyMs);
      return;
    }
    if (this.autoAcknowledge && (message.flags & MultiAgentFlag.ACK_REQUIRED) !== 0) {
      const ackPayload = new Uint8Array(4);
      const view = new DataView(ackPayload.buffer);
      view.setUint16(0, message.sourceRobotId, true);
      view.setUint16(2, message.sequence, true);
      setTimeout(() => this.emitMessage({
        protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
        messageKind: MultiAgentMessageKind.ACK,
        flags: 0,
        sourceRobotId: this.robotId,
        targetRobotId: message.sourceRobotId,
        sequence: this.nextSequence(),
        topicId: message.topicId,
        ttlMilliseconds: 2000,
        applicationPayload: ackPayload,
      }), this.delayedAcknowledgementMs + this.latencyMs);
    }
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  sendFromRobot(message: Omit<MultiAgentMessage, "protocolVersion" | "sourceRobotId" | "sequence">): void {
    this.emitMessage({
      ...message,
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      sourceRobotId: this.robotId,
      sequence: this.nextSequence(),
    });
  }

  emitRawMessageFromRobot(message: MultiAgentMessage): void {
    this.emitMessage(message);
  }

  private sendHello(): void {
    if (!this.connected) return;
    this.emitMessage({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.HELLO,
      flags: 0,
      sourceRobotId: UNASSIGNED_ROBOT_ID,
      targetRobotId: LAPTOP_COORDINATOR_ID,
      sequence: this.nextSequence(),
      topicId: 0,
      ttlMilliseconds: 5000,
      applicationPayload: encodeHelloPayload(defaultVirtualCapabilities(this.identity)),
    });
  }

  private emitMessage(message: MultiAgentMessage): void {
    if (!this.connected || Math.random() < this.packetLossRate) return;
    const packet = encodeXppPacket(
      XppMessageType.MULTI_AGENT,
      encodeMultiAgentMessage(message),
    );
    for (let offset = 0; offset < packet.length; offset += this.maximumFragmentSize) {
      const fragment = packet.slice(offset, offset + this.maximumFragmentSize);
      for (const listener of this.dataListeners) listener(fragment);
    }
  }

  private nextSequence(): number {
    const current = this.sequence;
    this.sequence = (this.sequence + 1) & 0xffff;
    return current;
  }
}
