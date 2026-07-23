import { afterEach, describe, expect, it } from "vitest";
import {
  BROADCAST_ROBOT_ID,
  LAPTOP_COORDINATOR_ID,
  MultiAgentFlag,
  MultiAgentMessageKind,
  MultiAgentTopic,
  MULTI_AGENT_PROTOCOL_VERSION,
  UNASSIGNED_ROBOT_ID,
} from "../protocol/constants";
import { defaultVirtualCapabilities, encodeHelloPayload } from "../protocol/capabilities";
import { RobotFleetManager } from "../fleet/RobotFleetManager";
import { VirtualRobotTransport } from "../transport/VirtualRobotTransport";

const managers: RobotFleetManager[] = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error("Timed out waiting for virtual fleet state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function createFleet(count: number): Promise<{ manager: RobotFleetManager; transports: VirtualRobotTransport[] }> {
  const manager = new RobotFleetManager();
  managers.push(manager);
  const transports: VirtualRobotTransport[] = [];
  for (let index = 0; index < count; index += 1) {
    const transport = new VirtualRobotTransport({ identity: `test-${index}`, maximumFragmentSize: index + 1 });
    transports.push(transport);
    await manager.addRobot(transport, `Robot ${index + 1}`);
  }
  await waitUntil(() => manager.getReadySessions().length === count);
  return { manager, transports };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const session of [...manager.getSessions()]) await manager.removeRobot(session.sessionId);
  }
});

describe("RobotFleetManager routing", () => {
  it("routes laptop unicast only to one robot and broadcast to every ready robot", async () => {
    const { manager, transports } = await createFleet(3);
    const firstId = manager.getReadySessions()[0].robotId!;
    await manager.publish({ targetRobotId: firstId, topicId: MultiAgentTopic.SYSTEM_TEST, payload: Uint8Array.of(1), qos: "normal", ttlMs: 1000 });
    expect(transports[0].receivedMessages.some((message) => message.topicId === MultiAgentTopic.SYSTEM_TEST)).toBe(true);
    expect(transports[1].receivedMessages.some((message) => message.topicId === MultiAgentTopic.SYSTEM_TEST)).toBe(false);
    await manager.broadcast({ topicId: MultiAgentTopic.ROBOT_STATUS, payload: Uint8Array.of(2), qos: "normal", ttlMs: 1000 });
    expect(transports.every((transport) => transport.receivedMessages.some((message) => message.topicId === MultiAgentTopic.ROBOT_STATUS))).toBe(true);
  });

  it("reuses an externally attached IDE session and publishes its alias directory", async () => {
    const manager = new RobotFleetManager();
    managers.push(manager);
    const transport = new VirtualRobotTransport({ identity: "external-ide" });
    const first = await manager.attachExternalRobot("bluetooth-ide:one", transport, "Blue XRP");
    await waitUntil(() => first.state === "ready");
    const second = await manager.attachExternalRobot(
      "bluetooth-ide:one",
      new VirtualRobotTransport({ identity: "unused" }),
      "Blue XRP",
    );
    expect(second).toBe(first);
    expect(manager.getSessions()).toHaveLength(1);
    const directory = transport.receivedMessages.find(
      (message) => message.topicId === MultiAgentTopic.TEAM_DIRECTORY,
    );
    expect(directory).toBeDefined();
    expect(directory!.applicationPayload[0]).toBe(1);
    const aliasLength = directory!.applicationPayload[3];
    expect(new TextDecoder().decode(directory!.applicationPayload.slice(4, 4 + aliasLength))).toBe("Blue XRP");
  });

  it("accepts restarted robot sequence numbers on consecutive external program runs", async () => {
    const manager = new RobotFleetManager();
    managers.push(manager);
    const transport = new VirtualRobotTransport({ identity: "repeat-run" });
    const session = await manager.attachExternalRobot("usb-ide:repeat", transport, "Repeat XRP");
    await waitUntil(() => session.state === "ready");
    const received: number[] = [];
    manager.onTopic(MultiAgentTopic.SYSTEM_TEST, (message) => received.push(message.applicationPayload[0]));
    const repeatedMessage = {
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      sourceRobotId: session.robotId!,
      targetRobotId: LAPTOP_COORDINATOR_ID,
      sequence: 7,
      topicId: MultiAgentTopic.SYSTEM_TEST,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(1),
    } as const;

    transport.emitRawMessageFromRobot(repeatedMessage);
    transport.emitRawMessageFromRobot(repeatedMessage);
    await waitUntil(() => received.length === 1);

    manager.prepareExternalRobotRun("usb-ide:repeat");
    expect(session.state).toBe("handshaking");
    transport.emitRawMessageFromRobot({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.HELLO,
      flags: 0,
      sourceRobotId: UNASSIGNED_ROBOT_ID,
      targetRobotId: LAPTOP_COORDINATOR_ID,
      sequence: 0,
      topicId: 0,
      ttlMilliseconds: 5000,
      applicationPayload: encodeHelloPayload(defaultVirtualCapabilities("repeat-run")),
    });
    await waitUntil(() => session.state === "ready");
    transport.emitRawMessageFromRobot(repeatedMessage);
    await waitUntil(() => received.length === 2);
  });

  it("routes robot A logically through the laptop to B and excludes A from robot broadcast", async () => {
    const { manager, transports } = await createFleet(3);
    const sessions = manager.getReadySessions();
    transports[0].sendFromRobot({
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      targetRobotId: sessions[1].robotId!,
      topicId: MultiAgentTopic.SYSTEM_TEST,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(7),
    });
    await waitUntil(() => transports[1].receivedMessages.some((message) => message.topicId === MultiAgentTopic.SYSTEM_TEST));
    const relayed = transports[1].receivedMessages.find((message) => message.topicId === MultiAgentTopic.SYSTEM_TEST)!;
    expect(relayed.sourceRobotId).toBe(sessions[0].robotId);
    expect(relayed.flags & MultiAgentFlag.RELAYED).not.toBe(0);

    const before = transports[0].receivedMessages.length;
    transports[0].sendFromRobot({
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      targetRobotId: BROADCAST_ROBOT_ID,
      topicId: MultiAgentTopic.BALL_STATE,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(9),
    });
    await waitUntil(() => transports[2].receivedMessages.some((message) => message.topicId === MultiAgentTopic.BALL_STATE));
    expect(transports[0].receivedMessages.length).toBe(before);
  });

  it("consumes robot-to-laptop topics, suppresses duplicates, and blocks relayed loops", async () => {
    const { manager, transports } = await createFleet(2);
    const sourceId = manager.getReadySessions()[0].robotId!;
    const received: number[] = [];
    manager.onTopic(MultiAgentTopic.SYSTEM_TEST, (message) => received.push(message.applicationPayload[0]));
    const message = {
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      sourceRobotId: sourceId,
      targetRobotId: LAPTOP_COORDINATOR_ID,
      sequence: 444,
      topicId: MultiAgentTopic.SYSTEM_TEST,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(4),
    } as const;
    transports[0].emitRawMessageFromRobot(message);
    transports[0].emitRawMessageFromRobot(message);
    await waitUntil(() => received.length === 1);
    expect(manager.getReadySessions()[0].metrics.duplicatePackets).toBe(1);

    transports[0].sendFromRobot({
      messageKind: MultiAgentMessageKind.DATA,
      flags: MultiAgentFlag.RELAYED,
      targetRobotId: manager.getReadySessions()[1].robotId!,
      topicId: MultiAgentTopic.ROBOT_POSE,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(1),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transports[1].receivedMessages.some((candidate) => candidate.topicId === MultiAgentTopic.ROBOT_POSE)).toBe(false);
  });

  it("keeps active-robot compatibility scoped to the selected robot", async () => {
    const { manager, transports } = await createFleet(2);
    const second = manager.getReadySessions()[1].robotId!;
    manager.setActiveLegacyRobot(second);
    await manager.publishToActiveRobot({ topicId: MultiAgentTopic.SYSTEM_TEST, payload: Uint8Array.of(8), qos: "normal", ttlMs: 1000 });
    expect(transports[0].receivedMessages.some((message) => message.topicId === MultiAgentTopic.SYSTEM_TEST)).toBe(false);
    expect(transports[1].receivedMessages.some((message) => message.topicId === MultiAgentTopic.SYSTEM_TEST)).toBe(true);
  });

  it("handles sequence wraparound and independent fragmented parser state", async () => {
    const { manager, transports } = await createFleet(2);
    const session = manager.getReadySessions()[0];
    const first = session.nextSequence();
    let wrapped = first;
    for (let index = 0; index < 65535; index += 1) wrapped = session.nextSequence();
    expect(wrapped).toBe((first - 1) & 0xffff);
    expect(session.nextSequence()).toBe(first);
    expect(transports[0].maximumFragmentSize).not.toBe(transports[1].maximumFragmentSize);
    expect(manager.getReadySessions().every((candidate) => candidate.metrics.invalidPackets === 0)).toBe(true);
  });

  it("reconnects without changing identity or duplicating notification handling", async () => {
    const { manager, transports } = await createFleet(1);
    const session = manager.getReadySessions()[0];
    const originalId = session.robotId;
    await manager.disconnectRobot(session.sessionId);
    await manager.connectRobot(session.sessionId);
    await waitUntil(() => session.state === "ready");
    expect(session.robotId).toBe(originalId);
    expect(session.metrics.reconnectCount).toBe(1);
    const before = session.metrics.messagesReceived;
    transports[0].sendFromRobot({
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      targetRobotId: LAPTOP_COORDINATOR_ID,
      topicId: MultiAgentTopic.SYSTEM_TEST,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(1),
    });
    await waitUntil(() => session.metrics.messagesReceived === before + 1);
  });

  it("rejects source impersonation and returns a structured error for an offline target", async () => {
    const { manager, transports } = await createFleet(1);
    const session = manager.getReadySessions()[0];
    const invalidBefore = session.metrics.invalidPackets;
    transports[0].emitRawMessageFromRobot({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      sourceRobotId: session.robotId! + 100,
      targetRobotId: LAPTOP_COORDINATOR_ID,
      sequence: 500,
      topicId: MultiAgentTopic.SYSTEM_TEST,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(1),
    });
    await waitUntil(() => session.metrics.invalidPackets === invalidBefore + 1);
    transports[0].sendFromRobot({
      messageKind: MultiAgentMessageKind.DATA,
      flags: 0,
      targetRobotId: 65000,
      topicId: MultiAgentTopic.SYSTEM_TEST,
      ttlMilliseconds: 1000,
      applicationPayload: Uint8Array.of(2),
    });
    await waitUntil(() => transports[0].receivedMessages.some((message) => message.messageKind === MultiAgentMessageKind.ERROR));
  });
});
