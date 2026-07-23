import { afterEach, describe, expect, it } from "vitest";
import { EmotionMultiAgentAdapter } from "../adapters/EmotionMultiAgentAdapter";
import { RobotFleetManager } from "../fleet/RobotFleetManager";
import { MultiAgentTopic } from "../protocol/constants";
import { VirtualRobotTransport } from "../transport/VirtualRobotTransport";

describe("optional emotion adapter", () => {
  const managers: RobotFleetManager[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      for (const session of [...manager.getSessions()]) await manager.removeRobot(session.sessionId);
    }
  });

  it("publishes only changed states and leaves reactions disabled by default", async () => {
    const manager = new RobotFleetManager();
    managers.push(manager);
    const transport = new VirtualRobotTransport({ identity: "emotion-test" });
    await manager.addRobot(transport);
    while (manager.getReadySessions().length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    const adapter = new EmotionMultiAgentAdapter(manager);
    const robotId = manager.getReadySessions()[0].robotId!;
    expect(await adapter.publishIfChanged(robotId, { emotionId: 9, generation: 1 })).toBe(true);
    expect(await adapter.publishIfChanged(robotId, { emotionId: 9, generation: 1 })).toBe(false);
    expect(transport.receivedMessages.filter((message) => message.topicId === MultiAgentTopic.EMOTION_STATE)).toHaveLength(1);
    adapter.dispose();
  });
});

