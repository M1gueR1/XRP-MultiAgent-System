import { describe, expect, it } from "vitest";
import { createSessionMetrics } from "../fleet/metrics";
import { RobotWriteScheduler } from "../fleet/writeScheduler";
import {
  LAPTOP_COORDINATOR_ID,
  MultiAgentFlag,
  MultiAgentMessageKind,
  MultiAgentTopic,
  MULTI_AGENT_PROTOCOL_VERSION,
} from "../protocol/constants";
import { decodeMultiAgentMessage, decodeXppPacket, type MultiAgentMessage } from "../protocol/message";
import type { RobotTransport } from "../transport/RobotTransport";

class ControlledTransport implements RobotTransport {
  connected = true;
  writes: MultiAgentMessage[] = [];
  delayMs = 0;
  connect = async () => { this.connected = true; };
  disconnect = async () => { this.connected = false; };
  isConnected = () => this.connected;
  onData = () => () => undefined;
  onDisconnected = () => () => undefined;
  writeData = async (data: Uint8Array) => {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.writes.push(decodeMultiAgentMessage(decodeXppPacket(data).payload));
  };
}

function message(sequence: number, topicId: number, flags = 0, ttl = 1000): MultiAgentMessage {
  return {
    protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
    messageKind: MultiAgentMessageKind.DATA,
    flags,
    sourceRobotId: LAPTOP_COORDINATOR_ID,
    targetRobotId: 1,
    sequence,
    topicId,
    ttlMilliseconds: ttl,
    applicationPayload: Uint8Array.of(sequence & 0xff),
  };
}

describe("per-session write scheduler", () => {
  it("coalesces latest-only messages and keeps queues bounded", async () => {
    const transport = new ControlledTransport();
    transport.delayMs = 10;
    const metrics = createSessionMetrics();
    const scheduler = new RobotWriteScheduler(transport, metrics);
    const sends = Array.from({ length: 20 }, (_, index) => scheduler.enqueue(message(index, MultiAgentTopic.DRIVE_VELOCITY, MultiAgentFlag.LATEST_ONLY)));
    await Promise.all(sends);
    expect(metrics.messagesCoalesced).toBeGreaterThan(0);
    expect(transport.writes.length).toBeLessThan(20);
    expect(metrics.maximumQueueDepth).toBeLessThanOrEqual(2);
  });

  it("retries reliable events only the configured number of times", async () => {
    const transport = new ControlledTransport();
    const metrics = createSessionMetrics();
    const scheduler = new RobotWriteScheduler(transport, metrics, { acknowledgementTimeoutMs: 5, maximumRetries: 2 });
    await expect(scheduler.enqueue(message(1, MultiAgentTopic.SYSTEM_TEST, MultiAgentFlag.ACK_REQUIRED, 100))).rejects.toThrow(/timed out/);
    expect(transport.writes).toHaveLength(3);
  });

  it("sends emergency stop before queued normal traffic and removes stale drive commands", async () => {
    const transport = new ControlledTransport();
    transport.delayMs = 10;
    const metrics = createSessionMetrics();
    const scheduler = new RobotWriteScheduler(transport, metrics);
    const blocker = scheduler.enqueue(message(1, MultiAgentTopic.SYSTEM_TEST));
    const drive = scheduler.enqueue(message(2, MultiAgentTopic.DRIVE_VELOCITY, MultiAgentFlag.LATEST_ONLY));
    const normal = scheduler.enqueue(message(3, MultiAgentTopic.ROBOT_STATUS));
    const stop = scheduler.enqueue(message(4, MultiAgentTopic.EMERGENCY_STOP, MultiAgentFlag.HIGH_PRIORITY));
    await Promise.all([blocker, drive, normal, stop]);
    expect(transport.writes.map((entry) => entry.topicId)).toEqual([
      MultiAgentTopic.SYSTEM_TEST,
      MultiAgentTopic.EMERGENCY_STOP,
      MultiAgentTopic.ROBOT_STATUS,
    ]);
  });

  it("does not let a slow robot scheduler block another robot", async () => {
    const slow = new ControlledTransport();
    slow.delayMs = 30;
    const fast = new ControlledTransport();
    const slowScheduler = new RobotWriteScheduler(slow, createSessionMetrics());
    const fastScheduler = new RobotWriteScheduler(fast, createSessionMetrics());
    const slowPromise = slowScheduler.enqueue(message(1, MultiAgentTopic.SYSTEM_TEST));
    await fastScheduler.enqueue(message(2, MultiAgentTopic.SYSTEM_TEST));
    expect(fast.writes).toHaveLength(1);
    expect(slow.writes).toHaveLength(0);
    await slowPromise;
  });
});

