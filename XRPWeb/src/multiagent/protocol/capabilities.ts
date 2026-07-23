import { MAX_MULTI_AGENT_APPLICATION_PAYLOAD, MULTI_AGENT_PROTOCOL_VERSION } from "./constants";

export interface RobotCapabilities {
  protocolVersion: number;
  libraryMajor: number;
  libraryMinor: number;
  maximumPayload: number;
  features: number;
  hardwareIdentity: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeHelloPayload(capabilities: RobotCapabilities): Uint8Array {
  const identity = encoder.encode(capabilities.hardwareIdentity);
  if (identity.length > 32) throw new RangeError("Hardware identity cannot exceed 32 UTF-8 bytes.");
  const result = new Uint8Array(8 + identity.length);
  const view = new DataView(result.buffer);
  result[0] = capabilities.protocolVersion;
  result[1] = capabilities.libraryMajor;
  result[2] = capabilities.libraryMinor;
  result[3] = capabilities.maximumPayload;
  view.setUint16(4, capabilities.features, true);
  result[6] = identity.length;
  result[7] = 0;
  result.set(identity, 8);
  return result;
}

export function decodeHelloPayload(payload: Uint8Array): RobotCapabilities {
  if (payload.length < 8) throw new Error("HELLO payload is too short.");
  const identityLength = payload[6];
  if (identityLength > 32 || payload.length !== 8 + identityLength) {
    throw new Error("HELLO hardware identity length is invalid.");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    protocolVersion: payload[0],
    libraryMajor: payload[1],
    libraryMinor: payload[2],
    maximumPayload: payload[3],
    features: view.getUint16(4, true),
    hardwareIdentity: decoder.decode(payload.slice(8)),
  };
}

export function encodeHelloAckPayload(robotId: number, heartbeatIntervalMs: number): Uint8Array {
  const result = new Uint8Array(7);
  const view = new DataView(result.buffer);
  view.setUint16(0, robotId, true);
  view.setUint16(2, 0, true);
  view.setUint16(4, heartbeatIntervalMs, true);
  result[6] = MULTI_AGENT_PROTOCOL_VERSION;
  return result;
}

export function defaultVirtualCapabilities(identity: string): RobotCapabilities {
  return {
    protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
    libraryMajor: 1,
    libraryMinor: 0,
    maximumPayload: MAX_MULTI_AGENT_APPLICATION_PAYLOAD,
    features: 0x000f,
    hardwareIdentity: identity,
  };
}

