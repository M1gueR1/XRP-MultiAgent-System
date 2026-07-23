export interface TopicCodec<T> {
  topicId: number;
  encode(value: T): Uint8Array;
  decode(payload: Uint8Array): T;
}

export interface DriveVelocity {
  linearMmPerSecond: number;
  angularMilliRadiansPerSecond: number;
}

export interface RobotPose {
  robotId: number;
  xMm: number;
  yMm: number;
  headingMilliRadians: number;
  observedAtMs: number;
}

export interface BallState {
  xMm: number;
  yMm: number;
  observedAtMs: number;
}

export class TopicCodecRegistry {
  private readonly codecs = new Map<number, TopicCodec<unknown>>();

  register<T>(codec: TopicCodec<T>): () => void {
    if (this.codecs.has(codec.topicId)) throw new Error(`Topic ${codec.topicId} already has a codec.`);
    this.codecs.set(codec.topicId, codec as TopicCodec<unknown>);
    return () => this.codecs.delete(codec.topicId);
  }

  get<T>(topicId: number): TopicCodec<T> | undefined {
    return this.codecs.get(topicId) as TopicCodec<T> | undefined;
  }
}

function requireLength(payload: Uint8Array, expected: number, name: string): void {
  if (payload.length !== expected) throw new Error(`${name} payload must be ${expected} bytes.`);
}

export const driveVelocityCodec: TopicCodec<DriveVelocity> = {
  topicId: 0x0101,
  encode(value) {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setInt16(0, value.linearMmPerSecond, true);
    view.setInt16(2, value.angularMilliRadiansPerSecond, true);
    return payload;
  },
  decode(payload) {
    requireLength(payload, 4, "DRIVE_VELOCITY");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      linearMmPerSecond: view.getInt16(0, true),
      angularMilliRadiansPerSecond: view.getInt16(2, true),
    };
  },
};

export const robotPoseCodec: TopicCodec<RobotPose> = {
  topicId: 0x0102,
  encode(value) {
    const payload = new Uint8Array(18);
    const view = new DataView(payload.buffer);
    view.setUint16(0, value.robotId, true);
    view.setInt32(2, value.xMm, true);
    view.setInt32(6, value.yMm, true);
    view.setInt32(10, value.headingMilliRadians, true);
    view.setUint32(14, value.observedAtMs, true);
    return payload;
  },
  decode(payload) {
    requireLength(payload, 18, "ROBOT_POSE");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      robotId: view.getUint16(0, true),
      xMm: view.getInt32(2, true),
      yMm: view.getInt32(6, true),
      headingMilliRadians: view.getInt32(10, true),
      observedAtMs: view.getUint32(14, true),
    };
  },
};

export const ballStateCodec: TopicCodec<BallState> = {
  topicId: 0x0103,
  encode(value) {
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setInt32(0, value.xMm, true);
    view.setInt32(4, value.yMm, true);
    view.setUint32(8, value.observedAtMs, true);
    return payload;
  },
  decode(payload) {
    requireLength(payload, 12, "BALL_STATE");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      xMm: view.getInt32(0, true),
      yMm: view.getInt32(4, true),
      observedAtMs: view.getUint32(8, true),
    };
  },
};
