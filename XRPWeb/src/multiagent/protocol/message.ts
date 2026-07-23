import {
  BROADCAST_ROBOT_ID,
  KNOWN_MULTI_AGENT_KINDS,
  MAX_MULTI_AGENT_APPLICATION_PAYLOAD,
  MAX_XPP_PAYLOAD,
  MULTI_AGENT_HEADER_LENGTH,
  MULTI_AGENT_PROTOCOL_VERSION,
  MultiAgentMessageKindValue,
  XPP_END_SEQUENCE,
  XPP_START_SEQUENCE,
} from "./constants";

export interface MultiAgentMessage {
  protocolVersion: number;
  messageKind: MultiAgentMessageKindValue;
  flags: number;
  sourceRobotId: number;
  targetRobotId: number;
  sequence: number;
  topicId: number;
  ttlMilliseconds: number;
  applicationPayload: Uint8Array;
}

function requireUint(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}.`);
  }
}

export function validateMultiAgentMessage(message: MultiAgentMessage): void {
  if (message.protocolVersion !== MULTI_AGENT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported multi-agent protocol version ${message.protocolVersion}.`);
  }
  if (!KNOWN_MULTI_AGENT_KINDS.has(message.messageKind)) {
    throw new Error(`Unknown multi-agent message kind ${message.messageKind}.`);
  }
  requireUint("flags", message.flags, 0xff);
  requireUint("sourceRobotId", message.sourceRobotId, BROADCAST_ROBOT_ID - 1);
  requireUint("targetRobotId", message.targetRobotId, BROADCAST_ROBOT_ID);
  requireUint("sequence", message.sequence, 0xffff);
  requireUint("topicId", message.topicId, 0xffff);
  requireUint("ttlMilliseconds", message.ttlMilliseconds, 0xffff);
  // `instanceof` rejects valid Uint8Array values created in another browser
  // realm (for example an iframe or jsdom TextEncoder).
  if (Object.prototype.toString.call(message.applicationPayload) !== "[object Uint8Array]") {
    throw new TypeError("applicationPayload must be a Uint8Array.");
  }
  if (message.applicationPayload.length > MAX_MULTI_AGENT_APPLICATION_PAYLOAD) {
    throw new RangeError(
      `Multi-agent application payload cannot exceed ${MAX_MULTI_AGENT_APPLICATION_PAYLOAD} bytes.`,
    );
  }
}

export function encodeMultiAgentMessage(message: MultiAgentMessage): Uint8Array {
  validateMultiAgentMessage(message);
  const result = new Uint8Array(
    MULTI_AGENT_HEADER_LENGTH + message.applicationPayload.length,
  );
  const view = new DataView(result.buffer);
  result[0] = message.protocolVersion;
  result[1] = message.messageKind;
  result[2] = message.flags;
  view.setUint16(3, message.sourceRobotId, true);
  view.setUint16(5, message.targetRobotId, true);
  view.setUint16(7, message.sequence, true);
  view.setUint16(9, message.topicId, true);
  view.setUint16(11, message.ttlMilliseconds, true);
  result[13] = message.applicationPayload.length;
  result.set(message.applicationPayload, MULTI_AGENT_HEADER_LENGTH);
  return result;
}

export function decodeMultiAgentMessage(payload: Uint8Array): MultiAgentMessage {
  if (payload.length < MULTI_AGENT_HEADER_LENGTH) {
    throw new Error("Multi-agent payload is shorter than the 14-byte header.");
  }
  const applicationPayloadLength = payload[13];
  if (applicationPayloadLength > MAX_MULTI_AGENT_APPLICATION_PAYLOAD) {
    throw new Error("Encoded application payload exceeds the protocol maximum.");
  }
  if (payload.length !== MULTI_AGENT_HEADER_LENGTH + applicationPayloadLength) {
    throw new Error("Encoded application payload length does not match the envelope.");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const message: MultiAgentMessage = {
    protocolVersion: payload[0],
    messageKind: payload[1] as MultiAgentMessageKindValue,
    flags: payload[2],
    sourceRobotId: view.getUint16(3, true),
    targetRobotId: view.getUint16(5, true),
    sequence: view.getUint16(7, true),
    topicId: view.getUint16(9, true),
    ttlMilliseconds: view.getUint16(11, true),
    applicationPayload: payload.slice(MULTI_AGENT_HEADER_LENGTH),
  };
  validateMultiAgentMessage(message);
  return message;
}

export interface XppPacket {
  messageType: number;
  payload: Uint8Array;
}

export function encodeXppPacket(messageType: number, payload: Uint8Array): Uint8Array {
  requireUint("messageType", messageType, 0xff);
  if (payload.length > MAX_XPP_PAYLOAD) {
    throw new RangeError(`XPP payload cannot exceed ${MAX_XPP_PAYLOAD} bytes.`);
  }
  const result = new Uint8Array(6 + payload.length);
  result.set(XPP_START_SEQUENCE, 0);
  result[2] = messageType;
  result[3] = payload.length;
  result.set(payload, 4);
  result.set(XPP_END_SEQUENCE, 4 + payload.length);
  return result;
}

export function decodeXppPacket(packet: Uint8Array): XppPacket {
  if (packet.length < 6) throw new Error("XPP packet is too short.");
  if (packet[0] !== XPP_START_SEQUENCE[0] || packet[1] !== XPP_START_SEQUENCE[1]) {
    throw new Error("Invalid XPP start sequence.");
  }
  const payloadLength = packet[3];
  if (packet.length !== payloadLength + 6) throw new Error("Invalid XPP length.");
  const endOffset = packet.length - 2;
  if (packet[endOffset] !== XPP_END_SEQUENCE[0] || packet[endOffset + 1] !== XPP_END_SEQUENCE[1]) {
    throw new Error("Invalid XPP end sequence.");
  }
  return { messageType: packet[2], payload: packet.slice(4, endOffset) };
}
