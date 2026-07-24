import type ConnectionMgr from '@/managers/connectionmgr';
import { BluetoothConnection } from '@/connections/bluetoothconnection';
import { ConnectionState } from '@/connections/connection';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/managers/appmgr', () => ({
    default: {
        getInstance: () => ({ emit: vi.fn() }),
    },
    EventType: {},
}));

type MutableBluetoothConnection = {
    connectionStates: ConnectionState;
    bleWriter: BluetoothRemoteGATTCharacteristic;
    bleDataWriter: BluetoothRemoteGATTCharacteristic;
    readWorkerRunning: boolean;
    processRuntimeUARTData: (data: Uint8Array) => void;
};

describe('BluetoothConnection write reliability', () => {
    it('retries a transient REPL write before reporting an error', async () => {
        const writeValue = vi.fn()
            .mockRejectedValueOnce(new DOMException('GATT operation failed', 'NetworkError'))
            .mockResolvedValueOnce(undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue },
        });

        await expect(connection.writeToDevice('first')).resolves.toBeUndefined();
        expect(writeValue).toHaveBeenCalledTimes(2);
    });

    it('retries a transient DATA write before reporting an error', async () => {
        const writeValue = vi.fn()
            .mockRejectedValueOnce(new DOMException('GATT operation failed', 'NetworkError'))
            .mockResolvedValueOnce(undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue: vi.fn(async () => undefined) },
            bleDataWriter: {
                properties: { writeWithoutResponse: false },
                writeValue,
            },
        });

        await expect(connection.writeRuntimeData(new Uint8Array([1]))).resolves.toBeUndefined();
        expect(writeValue).toHaveBeenCalledTimes(2);
    });

    it('fragments DATA frames to the XRP-safe ATT payload size', async () => {
        const chunks: number[][] = [];
        const writeValue = vi.fn(async (value: BufferSource) => {
            chunks.push(Array.from(value as Uint8Array));
        });
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue: vi.fn(async () => undefined) },
            bleDataWriter: {
                properties: { writeWithoutResponse: false },
                writeValue,
            },
        });
        const frame = new Uint8Array(45).map((_, index) => index);

        await connection.writeRuntimeData(frame);

        expect(writeValue).toHaveBeenCalledTimes(3);
        expect(chunks).toEqual([
            Array.from(frame.slice(0, 20)),
            Array.from(frame.slice(20, 40)),
            Array.from(frame.slice(40)),
        ]);
    });

    it('serializes REPL and DATA writes through one GATT queue', async () => {
        const firstWrite = deferredWrite();
        const order: string[] = [];
        const replWrite = vi.fn(async () => {
            order.push('repl-start');
            await firstWrite.promise;
            order.push('repl-end');
        });
        const dataWrite = vi.fn(async () => {
            order.push('data');
        });
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue: replWrite },
            bleDataWriter: {
                properties: { writeWithoutResponse: false },
                writeValue: dataWrite,
            },
        });

        const repl = connection.writeToDevice('run');
        const data = connection.writeRuntimeData(new Uint8Array([1]));
        await vi.waitFor(() => expect(order).toEqual(['repl-start']));
        firstWrite.resolve();
        await Promise.all([repl, data]);

        expect(order).toEqual(['repl-start', 'repl-end', 'data']);
    });

    it('falls back to ASCII-safe team frames when firmware has no BLE DATA characteristics', async () => {
        const writes: Uint8Array[] = [];
        const writeValue = vi.fn(async (value: BufferSource) => {
            writes.push(new Uint8Array(value as ArrayBuffer).slice());
        });
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue },
        });
        const packet = new Uint8Array([0xaa, 0x55, 0x30, 0x00, 0x55, 0xaa]);

        expect(connection.hasRuntimeDataChannel()).toBe(true);
        expect(connection.hasDedicatedRuntimeDataChannel()).toBe(false);
        await connection.writeRuntimeData(packet);

        expect(new TextDecoder().decode(writes[0])).toBe('__XRPMA__:aa55300055aa\n');
    });

    it('extracts fallback team frames from BLE UART without leaking them to the terminal', () => {
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        const received: Uint8Array[] = [];
        const terminal = vi.fn();
        connection.onRuntimeData((data) => received.push(data));
        connection.onData = terminal;
        const packet = new Uint8Array([0xaa, 0x55, 0x30, 0x00, 0x55, 0xaa]);
        const framed = new TextEncoder().encode('__XRPMA__:aa55300055aa\nSender ready\r\n');

        (connection as unknown as MutableBluetoothConnection).processRuntimeUARTData(framed);

        expect(received).toEqual([packet]);
        expect(terminal).toHaveBeenCalledWith('Sender ready\r\n');
    });

    it('reports a persistent GATT failure and recovers the queue for a later write', async () => {
        const transientFailure = new DOMException('GATT operation failed', 'NetworkError');
        const writeValue = vi.fn()
            .mockRejectedValueOnce(transientFailure)
            .mockRejectedValueOnce(transientFailure)
            .mockRejectedValueOnce(transientFailure)
            .mockResolvedValueOnce(undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue },
        });

        await expect(connection.writeToDevice('first')).rejects.toThrow(
            'failed after 3 attempts',
        );
        await expect(connection.writeToDevice('second')).resolves.toBeUndefined();
        expect(writeValue).toHaveBeenCalledTimes(4);
    });

    it('keeps the physical BLE link connected when only IDE initialization fails', async () => {
        const originalBluetooth = Object.getOwnPropertyDescriptor(navigator, 'bluetooth');
        const disconnect = vi.fn();
        const gatt = {
            connected: false,
            disconnect,
            connect: vi.fn(async () => {
                gatt.connected = true;
                return server;
            }),
        };
        const replWriter = {
            writeValue: vi.fn(async () => undefined),
        };
        const replReader = {
            startNotifications: vi.fn(async () => replReader),
            addEventListener: vi.fn(),
        };
        const dataWriter = {
            properties: { writeWithoutResponse: false },
            writeValue: vi.fn(async () => undefined),
        };
        const dataReader = {
            startNotifications: vi.fn(async () => dataReader),
            addEventListener: vi.fn(),
        };
        const server = {
            getPrimaryService: vi.fn(async () => ({
                getCharacteristic: vi.fn(async (uuid: string) => {
                    if (uuid.endsWith('0002-b5a3-f393-e0a9-e50e24dcca9e')) return replWriter;
                    if (uuid.endsWith('0003-b5a3-f393-e0a9-e50e24dcca9e')) return replReader;
                    if (uuid.endsWith('36ff')) return dataWriter;
                    return dataReader;
                }),
            })),
        };
        const device = {
            id: 'physical-xrp',
            name: 'XRP',
            gatt,
            addEventListener: vi.fn(),
        };
        Object.defineProperty(navigator, 'bluetooth', {
            configurable: true,
            value: { requestDevice: vi.fn(async () => device) },
        });
        const manager = {
            isBluetoothDeviceClaimed: () => false,
            connectCallback: vi.fn(async () => {
                throw new Error('REPL initialization failed');
            }),
        };
        const connection = new BluetoothConnection(
            manager as unknown as ConnectionMgr,
            { autoReconnect: false },
        );
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            readWorkerRunning: true,
        });

        try {
            await expect(connection.connect()).rejects.toThrow(
                'Bluetooth link is still connected',
            );
            expect(connection.isConnected()).toBe(true);
            expect(disconnect).not.toHaveBeenCalled();
        } finally {
            if (originalBluetooth) {
                Object.defineProperty(navigator, 'bluetooth', originalBluetooth);
            } else {
                Reflect.deleteProperty(navigator, 'bluetooth');
            }
        }
    });
});

function deferredWrite() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
