import {
  MAX_XPP_RECEIVE_BUFFER,
  XPP_END_SEQUENCE,
  XPP_START_SEQUENCE,
} from "./constants";

export interface XppStreamParserResult {
  packets: Uint8Array[];
  discardedBytes: number;
  malformedPackets: number;
  overflowed: boolean;
}

export class XppStreamParser {
  private buffer = new Uint8Array(0);

  constructor(private readonly maximumBufferSize = MAX_XPP_RECEIVE_BUFFER) {
    if (maximumBufferSize < 261) {
      throw new RangeError("XPP receive buffer must fit the largest possible frame.");
    }
  }

  get bufferedByteCount(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  push(chunk: Uint8Array): XppStreamParserResult {
    let overflowed = false;
    let discardedBytes = 0;
    let malformedPackets = 0;
    const packets: Uint8Array[] = [];
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    if (this.buffer.length > this.maximumBufferSize) {
      overflowed = true;
      discardedBytes += this.buffer.length - this.maximumBufferSize;
      this.buffer = this.buffer.slice(this.buffer.length - this.maximumBufferSize);
    }

    while (this.buffer.length > 0) {
      const start = this.findStart();
      if (start < 0) {
        const keepLast = this.buffer[this.buffer.length - 1] === XPP_START_SEQUENCE[0];
        const keep = keepLast ? 1 : 0;
        discardedBytes += this.buffer.length - keep;
        this.buffer = keep ? this.buffer.slice(-1) : new Uint8Array(0);
        break;
      }
      if (start > 0) {
        discardedBytes += start;
        this.buffer = this.buffer.slice(start);
      }
      if (this.buffer.length < 4) break;
      const totalLength = 6 + this.buffer[3];
      if (this.buffer.length < totalLength) break;
      const endOffset = totalLength - 2;
      if (
        this.buffer[endOffset] !== XPP_END_SEQUENCE[0] ||
        this.buffer[endOffset + 1] !== XPP_END_SEQUENCE[1]
      ) {
        malformedPackets += 1;
        discardedBytes += 1;
        this.buffer = this.buffer.slice(1);
        continue;
      }
      packets.push(this.buffer.slice(0, totalLength));
      this.buffer = this.buffer.slice(totalLength);
    }

    return { packets, discardedBytes, malformedPackets, overflowed };
  }

  private findStart(): number {
    for (let index = 0; index + 1 < this.buffer.length; index += 1) {
      if (
        this.buffer[index] === XPP_START_SEQUENCE[0] &&
        this.buffer[index + 1] === XPP_START_SEQUENCE[1]
      ) return index;
    }
    return -1;
  }
}

