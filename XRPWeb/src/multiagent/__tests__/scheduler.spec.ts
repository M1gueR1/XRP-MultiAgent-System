import { describe, expect, it } from "vitest";
import { createSessionMetrics } from "../fleet/metrics";
import { MessageExpiredBeforeSendError, RobotWriteScheduler } from "../fleet/writeScheduler";
import {
  LAPTOP_COORDINATOR_ID,
  MultiAgentFlag,
  MultiAgentMessageKind,
  MultiAgentTopic,
  MULTI_AGENT_PROTOCOL_VERSION,
} from "../protocol/constants";
import { decodeMultiAgentMessage, decodeXppPacket, type MultiAgentMessage } from "../protocol/message";
import type { RobotTransport } from "../transport/RobotTransport";
import type { PingWriteDiagnostics } from "../fleet/types";

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
  it("identifies deadline expiry before transport delivery and records queue waiting", async () => {
    const transport = new ControlledTransport();
    let release!: () => void;
    transport.writeData = async (data) => {
      transport.writes.push(decodeMultiAgentMessage(decodeXppPacket(data).payload));
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const metrics = createSessionMetrics();
    const scheduler = new RobotWriteScheduler(transport, metrics);
    const blocker = scheduler.enqueue(message(1, MultiAgentTopic.SYSTEM_TEST));
    const diagnostics: PingWriteDiagnostics = { channel: "unknown" };
    const expired = expect(scheduler.enqueue(message(2, 0x7f30, 0, 1), diagnostics)).rejects.toBeInstanceOf(MessageExpiredBeforeSendError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([blocker, expired]);
    expect(transport.writes.map((write) => write.sequence)).toEqual([1]);
    expect(diagnostics.schedulerQueueMs).toBeGreaterThan(1);
    expect(metrics.stalePackets).toBe(1);
  });
  it("identifies active and queued blockers without changing probe priority", async () => {
    const transport = new ControlledTransport();
    transport.delayMs = 15;
    const scheduler = new RobotWriteScheduler(transport, createSessionMetrics());
    const heartbeat = scheduler.enqueue({ ...message(1, 0), messageKind: MultiAgentMessageKind.HEARTBEAT });
    const directory = scheduler.enqueue(message(2, MultiAgentTopic.TEAM_DIRECTORY));
    const diagnostics: PingWriteDiagnostics = { channel: "unknown" };
    const probe = scheduler.enqueue({ ...message(3, 0), messageKind: MultiAgentMessageKind.PING }, diagnostics);
    expect(scheduler.hasPendingWrites).toBe(true);
    expect(diagnostics).toMatchObject({
      activeWriteAtEnqueue: "HEARTBEAT", queuedWritesAtEnqueue: "DATA:TEAM_DIRECTORY", pendingAcksAtEnqueue: 0,
    });
    await Promise.all([heartbeat, directory, probe]);
    expect(diagnostics.blockingWrites).toBe(2);
    expect(diagnostics.blockingMessageKinds).toBe("HEARTBEAT|DATA:TEAM_DIRECTORY");
    expect(diagnostics.blockingWriteMs).toBeGreaterThanOrEqual(15);
    expect(diagnostics.blockingWriteMs).toBeLessThanOrEqual(diagnostics.schedulerQueueMs!);
    expect(transport.writes.map((write) => write.sequence)).toEqual([1, 2, 3]);
    expect(scheduler.hasPendingWrites).toBe(false);
  });

  it("distinguishes pending reliable ACKs from writes blocking a probe", async () => {
    const transport = new ControlledTransport();
    const scheduler = new RobotWriteScheduler(transport, createSessionMetrics());
    const reliable = scheduler.enqueue(message(1, MultiAgentTopic.SYSTEM_TEST, MultiAgentFlag.ACK_REQUIRED));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.hasPendingWrites).toBe(false);
    const diagnostics: PingWriteDiagnostics = { channel: "unknown" };
    await scheduler.enqueue(message(2, MultiAgentTopic.SYSTEM_TEST), diagnostics);
    expect(diagnostics).toMatchObject({ pendingAcksAtEnqueue: 1, activeWriteAtEnqueue: "", blockingWrites: 0 });
    expect(scheduler.acknowledge(LAPTOP_COORDINATOR_ID, 1)).toBe(true);
    await reliable;
  });

  it("separates scheduler waiting from transport write time for a probe", async () => {
    const transport = new ControlledTransport();
    transport.delayMs = 20;
    const scheduler = new RobotWriteScheduler(transport, createSessionMetrics());
    const blocker = scheduler.enqueue(message(1, MultiAgentTopic.SYSTEM_TEST));
    const diagnostics: PingWriteDiagnostics = { channel: "unknown" };
    await scheduler.enqueue(message(2, MultiAgentTopic.SYSTEM_TEST), diagnostics);
    await blocker;
    expect(diagnostics.packetBytes).toBe(21);
    expect(diagnostics.queueDepthAtEnqueue).toBeGreaterThanOrEqual(0);
    expect(diagnostics.schedulerQueueMs).toBeGreaterThanOrEqual(10);
    expect(diagnostics.transportCallMs).toBeGreaterThanOrEqual(10);
    expect(diagnostics.writeFinishedAt).toBeDefined();
  });
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

