export const XPP_START_SEQUENCE = [0xaa, 0x55] as const;
export const XPP_END_SEQUENCE = [0x55, 0xaa] as const;

/** Central registry for every outer XPP message type used by XRPWeb. */
export const XppMessageType = {
  VARIABLE_DEFINITION: 0x01,
  VARIABLE_UPDATE: 0x02,
  VARIABLE_SUBSCRIBE: 0x03,
  VARIABLE_UNSUBSCRIBE: 0x04,
  PROGRAM_START: 0x05,
  PROGRAM_STOP: 0x06,
  MULTI_AGENT: 0x30,
} as const;

export const MultiAgentMessageKind = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  HEARTBEAT: 0x03,
  DATA: 0x10,
  ACK: 0x11,
  ERROR: 0x12,
  PING: 0x20,
  PONG: 0x21,
} as const;

export type MultiAgentMessageKindValue =
  (typeof MultiAgentMessageKind)[keyof typeof MultiAgentMessageKind];

export const MultiAgentFlag = {
  ACK_REQUIRED: 0x01,
  LATEST_ONLY: 0x02,
  HIGH_PRIORITY: 0x04,
  RELAYED: 0x08,
} as const;

export const MultiAgentTopic = {
  SYSTEM_TEST: 0x0001,
  ROBOT_STATUS: 0x0002,
  TEAM_DIRECTORY: 0x0003,
  EMERGENCY_STOP: 0x0100,
  DRIVE_VELOCITY: 0x0101,
  ROBOT_POSE: 0x0102,
  BALL_STATE: 0x0103,
  EMOTION_STATE: 0x0201,
  USER_DEFINED_BASE: 0x8000,
  EDUCATIONAL_DATA: 0x8000,
} as const;

export const MULTI_AGENT_PROTOCOL_VERSION = 1;
export const MULTI_AGENT_HEADER_LENGTH = 14;
export const MAX_MULTI_AGENT_APPLICATION_PAYLOAD = 220;
export const MAX_XPP_PAYLOAD = 255;
export const MAX_XPP_RECEIVE_BUFFER = 4096;

export const LAPTOP_COORDINATOR_ID = 0;
export const MIN_ASSIGNED_ROBOT_ID = 1;
export const MAX_ASSIGNED_ROBOT_ID = 65533;
export const UNASSIGNED_ROBOT_ID = 65534;
export const BROADCAST_ROBOT_ID = 65535;

export const KNOWN_MULTI_AGENT_KINDS = new Set<number>(
  Object.values(MultiAgentMessageKind),
);
