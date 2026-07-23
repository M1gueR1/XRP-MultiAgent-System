import {
  XPP_END_SEQUENCE,
  XPP_START_SEQUENCE,
  XppMessageType,
} from '../protocol/constants';

const USB_TEAM_PREFIX = new TextEncoder().encode('__XRPMA__:');

export interface USBTeamFrameParseResult {
  packets: Uint8Array[];
  regularData: Uint8Array;
}

export function encodeUSBTeamFrame(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(USB_TEAM_PREFIX.length + data.length * 2 + 1);
  result.set(USB_TEAM_PREFIX, 0);
  const hex = '0123456789abcdef';
  let offset = USB_TEAM_PREFIX.length;
  for (const value of data) {
    result[offset++] = hex.charCodeAt(value >> 4);
    result[offset++] = hex.charCodeAt(value & 0x0f);
  }
  result[offset] = 0x0a;
  return result;
}

export class USBTeamFrameParser {
  private buffer = new Uint8Array(0);

  push(data: Uint8Array): USBTeamFrameParseResult {
    this.buffer = concatenate(this.buffer, data);
    const packets: Uint8Array[] = [];
    let regularData = new Uint8Array(0);

    while (this.buffer.length > 0) {
      const start = findSequence(this.buffer, USB_TEAM_PREFIX);
      if (start < 0) {
        const keep = possiblePrefixLength(this.buffer, USB_TEAM_PREFIX);
        const emitLength = this.buffer.length - keep;
        regularData = concatenate(regularData, this.buffer.slice(0, emitLength));
        this.buffer = this.buffer.slice(emitLength);
        break;
      }
      if (start > 0) {
        regularData = concatenate(regularData, this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
      }

      const newline = this.buffer.indexOf(0x0a, USB_TEAM_PREFIX.length);
      if (newline < 0) {
        if (this.buffer.length > 1024) {
          regularData = concatenate(regularData, this.buffer.slice(0, 1));
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break;
      }

      let encoded = this.buffer.slice(USB_TEAM_PREFIX.length, newline);
      if (encoded[encoded.length - 1] === 0x0d) encoded = encoded.slice(0, -1);
      const packet = decodeHexPacket(encoded);
      const entireFrame = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      if (packet) packets.push(packet);
      else regularData = concatenate(regularData, entireFrame);
    }
    return { packets, regularData };
  }
}

function decodeHexPacket(encoded: Uint8Array): Uint8Array | null {
  if (encoded.length === 0 || encoded.length % 2 !== 0) return null;
  const result = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    const high = hexNibble(encoded[index * 2]);
    const low = hexNibble(encoded[index * 2 + 1]);
    if (high < 0 || low < 0) return null;
    result[index] = (high << 4) | low;
  }
  if (
    result.length < 6 ||
    result[0] !== XPP_START_SEQUENCE[0] ||
    result[1] !== XPP_START_SEQUENCE[1] ||
    result[2] !== XppMessageType.MULTI_AGENT ||
    result[3] + 6 !== result.length ||
    result[result.length - 2] !== XPP_END_SEQUENCE[0] ||
    result[result.length - 1] !== XPP_END_SEQUENCE[1]
  ) return null;
  return result;
}

function hexNibble(value: number): number {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return -1;
}

function findSequence(data: Uint8Array, sequence: Uint8Array): number {
  for (let start = 0; start <= data.length - sequence.length; start += 1) {
    if (sequence.every((value, index) => data[start + index] === value)) return start;
  }
  return -1;
}

function possiblePrefixLength(data: Uint8Array, prefix: Uint8Array): number {
  const maximum = Math.min(data.length, prefix.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    const start = data.length - length;
    if (prefix.slice(0, length).every((value, index) => data[start + index] === value)) {
      return length;
    }
  }
  return 0;
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.length + second.length);
  result.set(first);
  result.set(second, first.length);
  return result;
}
