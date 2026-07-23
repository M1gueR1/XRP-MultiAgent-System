import { describe, expect, it } from "vitest";
import {
  BROADCAST_ROBOT_ID,
  MAX_MULTI_AGENT_APPLICATION_PAYLOAD,
  MultiAgentFlag,
  MultiAgentMessageKind,
  MULTI_AGENT_PROTOCOL_VERSION,
  XppMessageType,
} from "../protocol/constants";
import {
  decodeMultiAgentMessage,
  decodeXppPacket,
  encodeMultiAgentMessage,
  encodeXppPacket,
  type MultiAgentMessage,
} from "../protocol/message";
import { XppStreamParser } from "../protocol/streamParser";

function example(payload = new Uint8Array([0xde, 0xad])): MultiAgentMessage {
  return {
    protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
    messageKind: MultiAgentMessageKind.DATA,
    flags: MultiAgentFlag.ACK_REQUIRED | MultiAgentFlag.RELAYED,
    sourceRobotId: 0x1234,
    targetRobotId: 0xabcd,
    sequence: 0x0102,
    topicId: 0x0304,
    ttlMilliseconds: 0x0506,
    applicationPayload: payload,
  };
}

describe("multi-agent protocol v1", () => {
  it("encodes the documented little-endian byte layout", () => {
    expect([...encodeMultiAgentMessage(example())]).toEqual([
      0x01, 0x10, 0x09, 0x34, 0x12, 0xcd, 0xab, 0x02,
      0x01, 0x04, 0x03, 0x06, 0x05, 0x02, 0xde, 0xad,
    ]);
  });

  it("round-trips the maximum application payload through XPP type 0x30", () => {
    const original = example(new Uint8Array(MAX_MULTI_AGENT_APPLICATION_PAYLOAD).fill(0xa5));
    const xpp = encodeXppPacket(XppMessageType.MULTI_AGENT, encodeMultiAgentMessage(original));
    const outer = decodeXppPacket(xpp);
    expect(outer.messageType).toBe(0x30);
    expect(decodeMultiAgentMessage(outer.payload)).toEqual(original);
  });

  it("rejects oversized, malformed, unknown-version, and invalid-ID messages", () => {
    expect(() => encodeMultiAgentMessage(example(new Uint8Array(221)))).toThrow(/220/);
    expect(() => encodeMultiAgentMessage({ ...example(), sourceRobotId: BROADCAST_ROBOT_ID })).toThrow();
    expect(() => decodeMultiAgentMessage(Uint8Array.from([2, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/version/);
    const wrongLength = encodeMultiAgentMessage(example()).slice(0, -1);
    expect(() => decodeMultiAgentMessage(wrongLength)).toThrow(/length/);
  });
});

describe("bounded XPP stream parser", () => {
  it("reconstructs fragmented packets and extracts multiple packets from one chunk", () => {
    const packet = encodeXppPacket(XppMessageType.MULTI_AGENT, encodeMultiAgentMessage(example()));
    const parser = new XppStreamParser();
    const found: Uint8Array[] = [];
    for (const byte of packet) found.push(...parser.push(Uint8Array.of(byte)).packets);
    expect(found).toEqual([packet]);
    expect(new XppStreamParser().push(Uint8Array.from([...packet, ...packet])).packets).toEqual([packet, packet]);
  });

  it("resynchronizes after terminal bytes and invalid framing", () => {
    const packet = encodeXppPacket(XppMessageType.MULTI_AGENT, encodeMultiAgentMessage(example()));
    const malformed = packet.slice();
    malformed[malformed.length - 1] = 0;
    const result = new XppStreamParser().push(Uint8Array.from([1, 2, 3, ...malformed, ...packet]));
    expect(result.packets).toEqual([packet]);
    expect(result.malformedPackets).toBeGreaterThan(0);
  });

  it("bounds hostile input", () => {
    const parser = new XppStreamParser(300);
    const result = parser.push(new Uint8Array(1000).fill(7));
    expect(result.overflowed).toBe(true);
    expect(parser.bufferedByteCount).toBeLessThanOrEqual(300);
  });
});

