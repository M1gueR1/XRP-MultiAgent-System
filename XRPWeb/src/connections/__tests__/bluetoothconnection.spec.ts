import type ConnectionMgr from '@/managers/connectionmgr';
import { BluetoothConnection } from '@/connections/bluetoothconnection';
import { ConnectionState } from '@/connections/connection';
import { describe, expect, it, vi } from 'vitest';
import type { TransportWriteDiagnostics } from '@/multiagent/transport/RobotTransport';

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
    it('rejects the firmware restart marker in file text, binary data and paths before writing', () => {
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        const marker = '##XRP' + 'STOP##';
        expect(() => connection.assertFileUploadSafe('/test.py', '# comment ' + marker)).toThrow('reserved restart marker');
        const bytes = new TextEncoder().encode('x'.repeat(247) + marker + '\n');
        expect(() => connection.assertFileUploadSafe('/test.py', bytes)).toThrow('reserved restart marker');
        expect(() => connection.assertFileUploadSafe('/' + marker + '.py', 'print(1)')).toThrow('reserved restart marker');
        expect(() => connection.assertFileUploadSafe('/test.py', '# firmware stop marker\nprint(1)')).not.toThrow();
        expect(() => connection.assertFileUploadSafe('/test.py', 'print("##XRP" + "STOP##")')).not.toThrow();
    });
    it('sends the unchanged 55-byte frame in one experimental UART write and keeps larger frames conservative', async () => {
        const withResponse = vi.fn(async () => undefined);
        const withoutResponse = vi.fn(async (_bytes: BufferSource) => undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { properties: { writeWithoutResponse: true }, writeValueWithResponse: withResponse,
                writeValueWithoutResponse: withoutResponse },
        });
        const release20 = connection.useRuntimeUartWithoutResponse(20);
        const release55 = connection.useRuntimeUartWithoutResponse(55);
        const diagnostics: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(22), diagnostics);
        expect(diagnostics).toMatchObject({ encodedBytes: 55, chunkSizeBytes: 55, chunks: 1, attempts: 1, retries: 0 });
        expect(new TextDecoder().decode(withoutResponse.mock.calls[0][0] as BufferSource)).toBe('__XRPMA__:' + '00'.repeat(22) + '\n');
        await connection.writeToDevice('print("A")');
        expect(withResponse).toHaveBeenCalledOnce();
        const larger: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(23), larger);
        expect(larger).toMatchObject({ encodedBytes: 57, chunkSizeBytes: 20, chunks: 3 });
        expect(withoutResponse.mock.calls.slice(1).map(([data]) => data.byteLength)).toEqual([20, 20, 17]);
        release55();
        release55();
        const restored20: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(22), restored20);
        expect(restored20).toMatchObject({ chunkSizeBytes: 20, chunks: 3 });
        release20();
        const restoredNormal: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(22), restoredNormal);
        expect(restoredNormal).toMatchObject({ writeMode: 'with-response', chunkSizeBytes: 55, chunks: 1 });
    });

    it.each(['generation', 'writer'])('rejects a stale 55-byte lease after a Bluetooth %s change', async (change) => {
        const withoutResponse = vi.fn(async () => undefined);
        const writer = { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: withoutResponse,
            writeValueWithResponse: vi.fn(async () => undefined) };
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, { connectionStates: ConnectionState.Connected, bleWriter: writer });
        const release = connection.useRuntimeUartWithoutResponse(55);
        Object.assign(connection, change === 'generation' ? { disconnectGeneration: 1 } : { bleWriter: { ...writer } });
        await expect(connection.writeRuntimeData(new Uint8Array(22))).rejects.toThrow('Bluetooth changed');
        expect(withoutResponse).not.toHaveBeenCalled();
        expect(() => connection.useRuntimeUartWithoutResponse(55)).toThrow('Bluetooth changed');
        release();
        const newRelease = connection.useRuntimeUartWithoutResponse(55);
        await expect(connection.writeRuntimeData(new Uint8Array(22))).resolves.toBeUndefined();
        expect(withoutResponse).toHaveBeenCalledOnce();
        newRelease();
    });

    it('never silently falls back when a 55-byte write is rejected and restores the normal path after release', async () => {
        const withoutResponse = vi.fn(async () => { throw new DOMException('MTU too small', 'InvalidModificationError'); });
        const withResponse = vi.fn(async () => undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, { connectionStates: ConnectionState.Connected,
            bleWriter: { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: withoutResponse,
                writeValueWithResponse: withResponse } });
        const release = connection.useRuntimeUartWithoutResponse(55);
        const diagnostics: TransportWriteDiagnostics = { channel: 'unknown' };
        await expect(connection.writeRuntimeData(new Uint8Array(22), diagnostics)).rejects.toThrow('failed after 1 attempt');
        expect(withoutResponse).toHaveBeenCalledOnce();
        expect(diagnostics).toMatchObject({ attempts: 1, retries: 0 });
        expect(withResponse).not.toHaveBeenCalled();
        release();
        await connection.writeRuntimeData(new Uint8Array(22));
        expect(withResponse).toHaveBeenCalledOnce();
        expect(() => connection.useRuntimeUartWithoutResponse(21 as 20)).toThrow('20 or 55');
    });

    it('uses bounded UART runtime chunks only during the experiment and preserves explicit REPL responses', async () => {
        const withResponse = vi.fn(async () => undefined);
        const withoutResponse = vi.fn(async (_bytes: BufferSource) => undefined);
        const legacy = vi.fn(async () => undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { properties: { writeWithoutResponse: true }, writeValueWithResponse: withResponse,
                writeValueWithoutResponse: withoutResponse, writeValue: legacy },
        });
        const firstRelease = connection.useRuntimeUartWithoutResponse();
        const secondRelease = connection.useRuntimeUartWithoutResponse();
        firstRelease();
        firstRelease();
        const diagnostics: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(22), diagnostics);
        expect(diagnostics).toMatchObject({ channel: 'ble-uart', writeMode: 'without-response', encodedBytes: 55,
            chunks: 3, attempts: 3, retries: 0 });
        expect(withoutResponse.mock.calls.map(([bytes]) => (bytes as BufferSource).byteLength)).toEqual([20, 20, 15]);
        const chunks = withoutResponse.mock.calls.map(([bytes]) => new Uint8Array(bytes as ArrayBuffer));
        expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))).toBe('__XRPMA__:' + '00'.repeat(22) + '\n');
        await connection.writeToDevice('print("A")');
        expect(withResponse).toHaveBeenCalledOnce();
        expect(withoutResponse).toHaveBeenCalledTimes(3);
        secondRelease();
        const restored: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(22), restored);
        expect(restored).toMatchObject({ writeMode: 'with-response', chunks: 1, attempts: 1 });
        expect(withResponse).toHaveBeenCalledTimes(2);
        expect(legacy).not.toHaveBeenCalled();
    });

    it('rejects the UART experiment if the robot does not advertise support', () => {
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, { bleWriter: { properties: { writeWithoutResponse: false },
            writeValue: vi.fn(), writeValueWithoutResponse: vi.fn() } });
        expect(connection.supportsRuntimeUartWithoutResponse()).toBe(false);
        expect(() => connection.useRuntimeUartWithoutResponse()).toThrow('does not advertise');
    });

    it('records DATA chunk count, GATT waiting and transient write retries without changing packet sizes', async () => {
        const blocker = deferredWrite();
        const replWrite = vi.fn(() => blocker.promise);
        const dataWrite = vi.fn()
            .mockRejectedValueOnce(new DOMException('GATT busy', 'NetworkError'))
            .mockResolvedValue(undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue: replWrite },
            bleDataWriter: { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: dataWrite },
        });
        const diagnostics: TransportWriteDiagnostics = { channel: 'unknown' };
        const repl = connection.writeToDevice('hold');
        const data = connection.writeRuntimeData(new Uint8Array(22), diagnostics);
        await vi.waitFor(() => expect(replWrite).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 20));
        blocker.resolve();
        await Promise.all([repl, data]);
        expect(diagnostics).toMatchObject({ channel: 'ble-data', encodedBytes: 22, chunks: 2, attempts: 3, retries: 1 });
        expect(diagnostics.gattQueueMs).toBeGreaterThanOrEqual(10);
        expect(diagnostics.gattOperationMs).toBeGreaterThanOrEqual(100);
        expect(dataWrite.mock.calls.map(([bytes]) => bytes.byteLength)).toEqual([20, 20, 2]);
    });

    it('records UART framing as 55 encoded bytes for a 22-byte probe', async () => {
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue: vi.fn(async () => undefined) },
        });
        const diagnostics: TransportWriteDiagnostics = { channel: 'unknown' };
        await connection.writeRuntimeData(new Uint8Array(22), diagnostics);
        expect(diagnostics).toMatchObject({ channel: 'ble-uart', encodedBytes: 55, chunks: 1, attempts: 1, retries: 0 });
        expect(diagnostics.gattQueueMs).toBeGreaterThanOrEqual(0);
        expect(diagnostics.gattOperationMs).toBeGreaterThanOrEqual(0);
    });
    it('asks for the repaired XRP again and rejects a different Bluetooth device', async () => {
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection, { bleDevice: { id: 'repaired-xrp' } });
        const reconnect = vi.spyOn(connection, 'reconnect').mockResolvedValue();
        const requestDevice = vi.fn()
            .mockResolvedValueOnce({ id: 'another-xrp' })
            .mockResolvedValueOnce({ id: 'repaired-xrp' });
        vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
        try {
            await expect(connection.reconnectWithDeviceChooser()).rejects.toThrow('same XRP');
            expect(reconnect).not.toHaveBeenCalled();
            await expect(connection.reconnectWithDeviceChooser()).resolves.toBeUndefined();
            expect(reconnect).toHaveBeenCalledWith(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('bounds and retries the Raw REPL transition instead of waiting forever', async () => {
        const writeValue = vi.fn(async () => undefined);
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleWriter: { writeValue },
        });
        const haltUntilRead = vi.spyOn(connection, 'haltUntilRead').mockResolvedValue([]);

        await expect(connection.getToRaw()).rejects.toThrow(
            'MicroPython Raw REPL did not respond after 2 attempts',
        );
        expect(haltUntilRead).toHaveBeenCalledTimes(2);
        expect(writeValue).toHaveBeenCalledTimes(4);
    });

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

    it('reconnects GATT and retries with a refreshed REPL characteristic after a disconnect', async () => {
        const firstWrite = vi.fn(async () => {
            gatt.connected = false;
            throw new DOMException(
                'GATT Server is disconnected. Cannot perform GATT operation. (Re)connect first.',
                'NetworkError',
            );
        });
        const recoveredWrite = vi.fn(async () => undefined);
        const replReader = {
            startNotifications: vi.fn(async () => replReader),
            addEventListener: vi.fn(),
        };
        const service = {
            getCharacteristic: vi.fn(async (uuid: string) => {
                if (uuid.endsWith('0002-b5a3-f393-e0a9-e50e24dcca9e')) {
                    return { writeValue: recoveredWrite };
                }
                if (uuid.endsWith('0003-b5a3-f393-e0a9-e50e24dcca9e')) return replReader;
                throw new Error('Optional DATA characteristic unavailable');
            }),
        };
        const server = {
            get connected() { return gatt.connected; },
            getPrimaryService: vi.fn(async () => service),
        };
        const gatt = {
            connected: true,
            connect: vi.fn(async () => {
                gatt.connected = true;
                return server;
            }),
        };
        const device = {
            gatt,
        };
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: true });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleDevice: device,
            bleWriter: { writeValue: firstWrite },
            readWorkerRunning: true,
            notificationStabilizationMs: 0,
        });

        await expect(connection.writeToDevice('first')).resolves.toBeUndefined();

        expect(firstWrite).toHaveBeenCalledOnce();
        expect(gatt.connect).toHaveBeenCalledOnce();
        expect(recoveredWrite).toHaveBeenCalledOnce();
    });

    it('rediscovers and retries a REPL characteristic that became invalid after reconnecting', async () => {
        const firstWrite = vi.fn(async () => {
            throw new DOMException(
                'Characteristic with UUID 6e400002-b5a3-f393-e0a9-e50e24dcca9e is no longer valid. Remember to retrieve the characteristic again after reconnecting.',
                'InvalidStateError',
            );
        });
        const recoveredWrite = vi.fn(async () => undefined);
        const replReader = {
            startNotifications: vi.fn(async () => replReader),
            addEventListener: vi.fn(),
        };
        const service = {
            getCharacteristic: vi.fn(async (uuid: string) => {
                if (uuid.endsWith('0002-b5a3-f393-e0a9-e50e24dcca9e')) {
                    return { writeValue: recoveredWrite };
                }
                if (uuid.endsWith('0003-b5a3-f393-e0a9-e50e24dcca9e')) return replReader;
                throw new Error('Optional DATA characteristic unavailable');
            }),
        };
        const gatt = {
            connected: true,
            getPrimaryService: vi.fn(async () => service),
        };
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: true });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleDevice: { gatt },
            bleWriter: { writeValue: firstWrite },
            readWorkerRunning: true,
            notificationStabilizationMs: 0,
        });

        await expect(connection.writeToDevice('first')).resolves.toBeUndefined();

        expect(firstWrite).toHaveBeenCalledOnce();
        expect(gatt.getPrimaryService).toHaveBeenCalledOnce();
        expect(recoveredWrite).toHaveBeenCalledOnce();
    });

    it('refreshes cached characteristics when Reconnect is pressed after IDE initialization fails', async () => {
        const refreshedWrite = vi.fn(async () => undefined);
        const replReader = {
            startNotifications: vi.fn(async () => replReader),
            addEventListener: vi.fn(),
        };
        const gatt = {
            connected: true,
            getPrimaryService: vi.fn(async () => ({
                getCharacteristic: vi.fn(async (uuid: string) => {
                    if (uuid.endsWith('0002-b5a3-f393-e0a9-e50e24dcca9e')) {
                        return { writeValue: refreshedWrite };
                    }
                    if (uuid.endsWith('0003-b5a3-f393-e0a9-e50e24dcca9e')) return replReader;
                    throw new Error('Optional DATA characteristic unavailable');
                }),
            })),
        };
        const connectCallback = vi.fn(async () => undefined);
        const connection = new BluetoothConnection(
            { connectCallback } as unknown as ConnectionMgr,
            { autoReconnect: true },
        );
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleDevice: { gatt },
            bleWriter: { writeValue: vi.fn(async () => undefined) },
            bleReader: replReader,
            readWorkerRunning: true,
            notificationStabilizationMs: 0,
        });

        await connection.reconnect(true);
        await connection.writeToDevice('retry');

        expect(gatt.getPrimaryService).toHaveBeenCalledOnce();
        expect(refreshedWrite).toHaveBeenCalledOnce();
        expect(connectCallback).toHaveBeenCalledOnce();
    });

    it('retries service discovery if GATT drops before the channel is ready', async () => {
        let notificationStarts = 0;
        const replReader = {
            startNotifications: vi.fn(async () => {
                notificationStarts += 1;
                if (notificationStarts === 1) gatt.connected = false;
                return replReader;
            }),
            addEventListener: vi.fn(),
        };
        const gatt = {
            connected: true,
            connect: vi.fn(async () => {
                gatt.connected = true;
                return gatt;
            }),
            getPrimaryService: vi.fn(async () => ({
                getCharacteristic: vi.fn(async (uuid: string) => {
                    if (uuid.endsWith('0003-b5a3-f393-e0a9-e50e24dcca9e')) return replReader;
                    if (uuid.endsWith('0002-b5a3-f393-e0a9-e50e24dcca9e')) {
                        return { writeValue: vi.fn(async () => undefined) };
                    }
                    throw new Error('Optional DATA characteristic unavailable');
                }),
            })),
        };
        const connection = new BluetoothConnection(
            { connectCallback: vi.fn(async () => undefined) } as unknown as ConnectionMgr,
            { autoReconnect: true },
        );
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Disconnected,
            bleDevice: { gatt },
            readWorkerRunning: true,
            notificationStabilizationMs: 0,
        });

        await connection.reconnect(true);

        expect(gatt.getPrimaryService).toHaveBeenCalledTimes(2);
        expect(gatt.connect).toHaveBeenCalledOnce();
        expect(connection.isConnected()).toBe(true);
    });

    it('verifies the MicroPython prompt after the stop command reconnects', async () => {
        const connection = new BluetoothConnection({} as ConnectionMgr, { autoReconnect: false });
        const checkPrompt = vi.spyOn(connection, 'checkPrompt')
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const writeToDevice = vi.spyOn(connection, 'writeToDevice').mockImplementation(async () => {
            Object.assign(connection, { disconnectGeneration: 1 });
        });
        Object.assign(connection as unknown as MutableBluetoothConnection, {
            connectionStates: ConnectionState.Connected,
            bleDevice: { gatt: { connected: true } },
        });

        await expect(connection.getToREPL()).resolves.toBe(true);

        expect(checkPrompt).toHaveBeenCalledTimes(3);
        expect(writeToDevice).toHaveBeenCalledWith('##XRPSTOP##');
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
                'Bluetooth GATT is connected, but the IDE is not ready',
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
