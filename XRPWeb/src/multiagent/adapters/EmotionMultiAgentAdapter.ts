import { MultiAgentTopic } from "../protocol/constants";
import type { MultiAgentMessage } from "../protocol/message";
import type { RobotFleetManager } from "../fleet/RobotFleetManager";

export interface EmotionStatePayload {
  emotionId: number;
  generation: number;
  flags?: number;
}

export interface EmotionReactionRule {
  sourceRobotId?: number;
  sourceEmotionId: number;
  targetRobotId: number;
  targetEmotionId: number;
}

export function encodeEmotionState(value: EmotionStatePayload): Uint8Array {
  if (!Number.isInteger(value.emotionId) || value.emotionId < 0 || value.emotionId > 255) {
    throw new RangeError("emotionId must fit in one byte.");
  }
  if (!Number.isInteger(value.generation) || value.generation < 0 || value.generation > 65535) {
    throw new RangeError("generation must fit in an unsigned 16-bit value.");
  }
  const payload = new Uint8Array(4);
  payload[0] = value.emotionId;
  new DataView(payload.buffer).setUint16(1, value.generation, true);
  payload[3] = value.flags ?? 0;
  return payload;
}

export function decodeEmotionState(payload: Uint8Array): EmotionStatePayload {
  if (payload.length !== 4) throw new Error("Emotion state payload must contain four bytes.");
  return {
    emotionId: payload[0],
    generation: new DataView(payload.buffer, payload.byteOffset).getUint16(1, true),
    flags: payload[3],
  };
}

export class EmotionMultiAgentAdapter {
  private readonly lastPublished = new Map<number, string>();
  private rules: EmotionReactionRule[] = [];
  private reactionsEnabled = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly fleet: RobotFleetManager) {
    this.unsubscribe = fleet.onTopic(
      MultiAgentTopic.EMOTION_STATE,
      (message) => void this.handleIncoming(message),
    );
  }

  setReactionRules(rules: EmotionReactionRule[]): void {
    this.rules = [...rules];
  }

  setReactionsEnabled(enabled: boolean): void {
    this.reactionsEnabled = enabled;
  }

  async publishIfChanged(targetRobotId: number, state: EmotionStatePayload): Promise<boolean> {
    const key = `${state.emotionId}:${state.generation}:${state.flags ?? 0}`;
    if (this.lastPublished.get(targetRobotId) === key) return false;
    this.lastPublished.set(targetRobotId, key);
    await this.fleet.publish({
      targetRobotId,
      topicId: MultiAgentTopic.EMOTION_STATE,
      payload: encodeEmotionState(state),
      qos: "reliable",
      ttlMs: 2000,
    });
    return true;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async handleIncoming(message: MultiAgentMessage): Promise<void> {
    if (!this.reactionsEnabled) return;
    const state = decodeEmotionState(message.applicationPayload);
    const matching = this.rules.filter((rule) =>
      rule.sourceEmotionId === state.emotionId &&
      (rule.sourceRobotId === undefined || rule.sourceRobotId === message.sourceRobotId),
    );
    for (const rule of matching) {
      await this.publishIfChanged(rule.targetRobotId, {
        emotionId: rule.targetEmotionId,
        generation: (state.generation + 1) & 0xffff,
      });
    }
  }
}

