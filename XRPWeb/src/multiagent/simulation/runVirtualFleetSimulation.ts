import { RobotFleetManager } from "../fleet/RobotFleetManager";
import { MultiAgentTopic } from "../protocol/constants";
import { VirtualRobotTransport } from "../transport/VirtualRobotTransport";

export interface VirtualFleetSimulationResult {
  kind: "simulated";
  robots: number;
  logicalDurationSeconds: number;
  requestedFrequencyHz: number;
  updatesRequested: number;
  messagesPhysicallyWritten: number;
  messagesCoalesced: number;
  messagesDropped: number;
  maximumQueueDepth: number;
  wrongRobotDeliveries: number;
}

async function waitReady(fleet: RobotFleetManager, count: number): Promise<void> {
  const started = performance.now();
  while (fleet.getReadySessions().length !== count) {
    if (performance.now() - started > 2000) throw new Error("Virtual fleet handshake timed out.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Runs logical load quickly; it is not a claim about physical BLE wall-clock performance. */
export async function runVirtualFleetSimulation(
  robotCount: number,
  logicalDurationSeconds = 60,
  frequencyHz = 20,
): Promise<VirtualFleetSimulationResult> {
  const fleet = new RobotFleetManager();
  const transports: VirtualRobotTransport[] = [];
  for (let index = 0; index < robotCount; index += 1) {
    const transport = new VirtualRobotTransport({
      identity: `load-${robotCount}-${index}-${Math.random().toString(36).slice(2)}`,
      latencyMs: 1,
      maximumFragmentSize: 1 + (index % 7),
    });
    transports.push(transport);
    await fleet.addRobot(transport, `Load Robot ${index + 1}`);
  }
  await waitReady(fleet, robotCount);
  const sessions = fleet.getReadySessions();
  const pending: Promise<void>[] = [];
  const ticks = logicalDurationSeconds * frequencyHz;
  for (let tick = 0; tick < ticks; tick += 1) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, tick, true);
    for (const session of sessions) {
      pending.push(fleet.publish({
        targetRobotId: session.robotId!,
        topicId: MultiAgentTopic.ROBOT_STATUS,
        payload,
        qos: "latest",
        ttlMs: 250,
      }));
    }
  }
  await Promise.all(pending);

  let wrongRobotDeliveries = 0;
  transports.forEach((transport, index) => {
    const expectedId = sessions[index].robotId;
    for (const message of transport.receivedMessages) {
      if (message.topicId === MultiAgentTopic.ROBOT_STATUS && message.targetRobotId !== expectedId) {
        wrongRobotDeliveries += 1;
      }
    }
  });
  const result: VirtualFleetSimulationResult = {
    kind: "simulated",
    robots: robotCount,
    logicalDurationSeconds,
    requestedFrequencyHz: frequencyHz,
    updatesRequested: ticks * robotCount,
    messagesPhysicallyWritten: sessions.reduce((sum, session) => sum + session.metrics.messagesSent, 0),
    messagesCoalesced: sessions.reduce((sum, session) => sum + session.metrics.messagesCoalesced, 0),
    messagesDropped: sessions.reduce((sum, session) => sum + session.metrics.messagesDropped, 0),
    maximumQueueDepth: Math.max(...sessions.map((session) => session.metrics.maximumQueueDepth)),
    wrongRobotDeliveries,
  };
  for (const session of [...fleet.getSessions()]) await fleet.removeRobot(session.sessionId);
  return result;
}

