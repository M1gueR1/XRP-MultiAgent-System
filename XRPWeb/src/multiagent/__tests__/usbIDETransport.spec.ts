import type { USBConnection } from '@/connections/usbconnection';
import { describe, expect, it } from 'vitest';
import { USBIDETransport } from '../transport/USBIDETransport';
import { encodeUSBTeamFrame, USBTeamFrameParser } from '../transport/USBSerialTeamFraming';

describe('USBIDETransport', () => {
  it('reuses the open serial session for framed team data', async () => {
    const writes: Uint8Array[] = [];
    let dataListener: ((data: Uint8Array) => void) | undefined;
    const connection = {
      isConnected: () => true,
      hasRuntimeDataChannel: () => true,
      writeRuntimeData: async (data: Uint8Array) => { writes.push(data); },
      onRuntimeData: (listener: (data: Uint8Array) => void) => {
        dataListener = listener;
        return () => { dataListener = undefined; };
      },
      onRuntimeDisconnected: () => () => undefined,
    } as unknown as USBConnection;
    const transport = new USBIDETransport(connection);
    const received: Uint8Array[] = [];
    transport.onData((data) => received.push(data));

    await transport.connect();
    const packet = new Uint8Array([0xaa, 0x55, 0x30, 0x00, 0x55, 0xaa]);
    await transport.writeData(packet);
    dataListener?.(packet);

    expect(transport.isConnected()).toBe(true);
    expect(writes).toEqual([packet]);
    expect(received).toEqual([packet]);
  });

  it('round-trips fragmented ASCII-safe frames without leaking them to the terminal', () => {
    const parser = new USBTeamFrameParser();
    const packet = new Uint8Array([0xaa, 0x55, 0x30, 0x00, 0x55, 0xaa]);
    const frame = encodeUSBTeamFrame(packet);
    const terminal = new TextEncoder().encode('ready\r\n');
    const first = new Uint8Array(terminal.length + 5);
    first.set(terminal);
    first.set(frame.slice(0, 5), terminal.length);

    const partial = parser.push(first);
    const completed = parser.push(frame.slice(5));

    expect(new TextDecoder().decode(partial.regularData)).toBe('ready\r\n');
    expect(partial.packets).toEqual([]);
    expect(completed.regularData).toHaveLength(0);
    expect(completed.packets).toEqual([packet]);
  });
});
