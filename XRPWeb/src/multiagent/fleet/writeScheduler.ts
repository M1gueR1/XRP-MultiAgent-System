import { MultiAgentFlag, MultiAgentTopic } from "../protocol/constants";
import type { MultiAgentMessage } from "../protocol/message";
import { encodeMultiAgentMessage, encodeXppPacket } from "../protocol/message";
import { XppMessageType } from "../protocol/constants";
import type { RobotTransport } from "../transport/RobotTransport";
import { monotonicNow } from "./metrics";
import type { RobotSessionMetrics } from "./types";

interface ScheduledWrite {
  message: MultiAgentMessage;
  packet: Uint8Array;
  enqueuedAt: number;
  retries: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingAck {
  write: ScheduledWrite;
  timer: ReturnType<typeof setTimeout>;
}

export interface WriteSchedulerOptions {
  maximumHighPriorityQueue?: number;
  maximumLatestOnlyEntries?: number;
  maximumNormalQueue?: number;
  maximumReliableQueue?: number;
  acknowledgementTimeoutMs?: number;
  maximumRetries?: number;
}

export class RobotWriteScheduler {
  private readonly highPriorityQueue: ScheduledWrite[] = [];
  private readonly reliableQueue: ScheduledWrite[] = [];
  private readonly latestOnly = new Map<string, ScheduledWrite>();
  private readonly normalQueue: ScheduledWrite[] = [];
  private readonly pendingAcks = new Map<string, PendingAck>();
  private writing = false;
  private stopped = false;
  private readonly maximumNormalQueue: number;
  private readonly maximumReliableQueue: number;
  private readonly maximumHighPriorityQueue: number;
  private readonly maximumLatestOnlyEntries: number;
  private readonly acknowledgementTimeoutMs: number;
  private readonly maximumRetries: number;

  constructor(
    private readonly transport: RobotTransport,
    private readonly metrics: RobotSessionMetrics,
    options: WriteSchedulerOptions = {},
  ) {
    this.maximumNormalQueue = options.maximumNormalQueue ?? 64;
    this.maximumReliableQueue = options.maximumReliableQueue ?? 32;
    this.maximumHighPriorityQueue = options.maximumHighPriorityQueue ?? 16;
    this.maximumLatestOnlyEntries = options.maximumLatestOnlyEntries ?? 64;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 500;
    this.maximumRetries = options.maximumRetries ?? 2;
  }

  enqueue(message: MultiAgentMessage): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Robot write scheduler is stopped."));
    const packet = encodeXppPacket(
      XppMessageType.MULTI_AGENT,
      encodeMultiAgentMessage(message),
    );
    return new Promise<void>((resolve, reject) => {
      const write: ScheduledWrite = {
        message,
        packet,
        enqueuedAt: monotonicNow(),
        retries: 0,
        resolve,
        reject,
      };
      const isHigh = (message.flags & MultiAgentFlag.HIGH_PRIORITY) !== 0;
      const isReliable = (message.flags & MultiAgentFlag.ACK_REQUIRED) !== 0;
      const isLatest = (message.flags & MultiAgentFlag.LATEST_ONLY) !== 0;

      if (isHigh) {
        if (message.topicId === MultiAgentTopic.EMERGENCY_STOP) this.clearQueuedDriveCommands();
        if (this.highPriorityQueue.length >= this.maximumHighPriorityQueue) {
          if (message.topicId === MultiAgentTopic.EMERGENCY_STOP) {
            const displaced = this.highPriorityQueue.pop();
            if (displaced) displaced.reject(new Error("High-priority message displaced by emergency stop."));
            this.metrics.messagesDropped += 1;
          } else {
            this.metrics.messagesDropped += 1;
            reject(new Error("High-priority message queue is full."));
            return;
          }
        }
        this.highPriorityQueue.push(write);
      } else if (isLatest) {
        const key = `${message.targetRobotId}:${message.topicId}`;
        const replaced = this.latestOnly.get(key);
        if (replaced) {
          this.metrics.messagesCoalesced += 1;
          replaced.resolve();
        }
        if (!replaced && this.latestOnly.size >= this.maximumLatestOnlyEntries) {
          this.metrics.messagesDropped += 1;
          reject(new Error("Latest-only message map is full."));
          return;
        }
        this.latestOnly.set(key, write);
      } else if (isReliable) {
        if (this.reliableQueue.length >= this.maximumReliableQueue) {
          this.metrics.messagesDropped += 1;
          reject(new Error("Reliable event queue is full."));
          return;
        }
        this.reliableQueue.push(write);
      } else {
        if (this.normalQueue.length >= this.maximumNormalQueue) {
          this.metrics.messagesDropped += 1;
          reject(new Error("Normal message queue is full."));
          return;
        }
        this.normalQueue.push(write);
      }
      this.updateDepth();
      void this.drain();
    });
  }

  acknowledge(sourceRobotId: number, sequence: number): boolean {
    const key = this.ackKey(sourceRobotId, sequence);
    const pending = this.pendingAcks.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(key);
    pending.write.resolve();
    this.updateDepth();
    return true;
  }

  stop(): void {
    this.stopped = true;
    const error = new Error("Robot write scheduler stopped before delivery.");
    for (const queue of [this.highPriorityQueue, this.reliableQueue, this.normalQueue]) {
      for (const write of queue.splice(0)) write.reject(error);
    }
    for (const write of this.latestOnly.values()) write.reject(error);
    this.latestOnly.clear();
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.write.reject(error);
    }
    this.pendingAcks.clear();
    this.updateDepth();
  }

  private async drain(): Promise<void> {
    if (this.writing || this.stopped) return;
    this.writing = true;
    try {
      while (!this.stopped && this.transport.isConnected()) {
        const write = this.nextWrite();
        if (!write) break;
        if (this.isStale(write)) {
          this.metrics.stalePackets += 1;
          this.metrics.messagesDropped += 1;
          write.reject(new Error("Message expired before it could be sent."));
          continue;
        }
        try {
          await this.transport.writeData(write.packet);
          this.metrics.messagesSent += 1;
          this.metrics.bytesSent += write.packet.length;
          this.metrics.lastSentAt = Date.now();
          if ((write.message.flags & MultiAgentFlag.ACK_REQUIRED) !== 0) {
            this.waitForAcknowledgement(write);
          } else {
            write.resolve();
          }
        } catch (error) {
          this.metrics.messagesDropped += 1;
          write.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.updateDepth();
      }
    } finally {
      this.writing = false;
      this.updateDepth();
    }
  }

  private nextWrite(): ScheduledWrite | undefined {
    const high = this.highPriorityQueue.shift();
    if (high) return high;
    const reliable = this.reliableQueue.shift();
    if (reliable) return reliable;
    const latestEntry = this.latestOnly.entries().next();
    if (!latestEntry.done) {
      const [key, value] = latestEntry.value;
      this.latestOnly.delete(key);
      return value;
    }
    return this.normalQueue.shift();
  }

  private waitForAcknowledgement(write: ScheduledWrite): void {
    const key = this.ackKey(write.message.sourceRobotId, write.message.sequence);
    const timer = setTimeout(() => {
      this.pendingAcks.delete(key);
      if (write.retries >= this.maximumRetries || this.isStale(write)) {
        this.metrics.messagesDropped += 1;
        write.reject(new Error("Reliable event acknowledgement timed out."));
        this.updateDepth();
        return;
      }
      write.retries += 1;
      this.reliableQueue.unshift(write);
      this.updateDepth();
      void this.drain();
    }, this.acknowledgementTimeoutMs);
    this.pendingAcks.set(key, { write, timer });
  }

  private clearQueuedDriveCommands(): void {
    for (const [key, write] of this.latestOnly) {
      if (write.message.topicId === MultiAgentTopic.DRIVE_VELOCITY) {
        this.latestOnly.delete(key);
        this.metrics.messagesDropped += 1;
        write.resolve();
      }
    }
    for (let index = this.normalQueue.length - 1; index >= 0; index -= 1) {
      if (this.normalQueue[index].message.topicId === MultiAgentTopic.DRIVE_VELOCITY) {
        const [write] = this.normalQueue.splice(index, 1);
        this.metrics.messagesDropped += 1;
        write.resolve();
      }
    }
  }

  private isStale(write: ScheduledWrite): boolean {
    const ttl = write.message.ttlMilliseconds;
    return ttl > 0 && monotonicNow() - write.enqueuedAt > ttl;
  }

  private ackKey(sourceRobotId: number, sequence: number): string {
    return `${sourceRobotId}:${sequence}`;
  }

  private updateDepth(): void {
    this.metrics.outgoingQueueDepth =
      this.highPriorityQueue.length + this.reliableQueue.length +
      this.latestOnly.size + this.normalQueue.length + this.pendingAcks.size;
    this.metrics.maximumQueueDepth = Math.max(
      this.metrics.maximumQueueDepth,
      this.metrics.outgoingQueueDepth,
    );
  }
}
