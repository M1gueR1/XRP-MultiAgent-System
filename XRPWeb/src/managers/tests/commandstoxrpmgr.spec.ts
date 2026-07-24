import type Connection from '@/connections/connection';
import { CommandToXRPMgr } from '@/managers/commandstoxrpmgr';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('CommandToXRPMgr session isolation', () => {
    it('finishes a battery check on the connection where it started', async () => {
        const result = deferred<string[]>();
        const first = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(() => result.promise),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const second = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(async () => ['OK0']),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(first);

        const voltagePromise = commands.batteryVoltage();
        await Promise.resolve();
        commands.setConnection(second);
        result.resolve(['OK32768']);

        await expect(voltagePromise).resolves.toBeCloseTo(7, 3);
        expect(first.writeUtilityCmdRaw).toHaveBeenCalledOnce();
        expect(first.getToNormal).toHaveBeenCalledOnce();
        expect(second.writeUtilityCmdRaw).not.toHaveBeenCalled();
        expect(second.getToNormal).not.toHaveBeenCalled();
    });

    it('verifies uploaded file sizes and releases the busy lock', async () => {
        const connection = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(async () => [
                'OKXRPVERIFY:/receiver.py:12',
                'XRPVERIFY_DONE',
            ]),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);

        await expect(commands.verifyUploadedFiles([
            { path: '/receiver.py', byteLength: 12 },
        ])).resolves.toBeUndefined();

        expect(connection.writeUtilityCmdRaw).toHaveBeenCalledOnce();
        expect(connection.getToNormal).toHaveBeenCalledOnce();
        expect(commands.BUSY).toBe(false);
    });

    it('rejects a truncated upload verification and releases the busy lock', async () => {
        const connection = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(async () => [
                'OKXRPVERIFY:/sender.py:4',
                'XRPVERIFY_DONE',
            ]),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);

        await expect(commands.verifyUploadedFiles([
            { path: '/sender.py', byteLength: 40 },
        ])).rejects.toThrow('upload verification failed');

        expect(connection.writeUtilityCmdRaw).toHaveBeenCalledTimes(2);
        expect(connection.getToNormal).toHaveBeenCalledTimes(2);
        expect(commands.BUSY).toBe(false);
    });

    it('retries a transient BLE verification response before failing the Run', async () => {
        const connection = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn()
                .mockResolvedValueOnce(['XRPVERIFY_DONE'])
                .mockResolvedValueOnce([
                    'XRPVERIFY:/sender.py:40',
                    'XRPVERIFY_DONE',
                ]),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);

        await expect(commands.verifyUploadedFiles([
            { path: '/sender.py', byteLength: 40 },
        ])).resolves.toBeUndefined();

        expect(connection.writeUtilityCmdRaw).toHaveBeenCalledTimes(2);
        expect(commands.BUSY).toBe(false);
    });

    it('uploads a multi-file bundle through one Raw REPL stream', async () => {
        const writes: number[][] = [];
        const connection = {
            XRP_SEND_BLOCK_SIZE: 4,
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(async () => ['XRPBATCH_STARTED']),
            startReaduntil: vi.fn(),
            writeToDevice: vi.fn(async (value: Uint8Array) => {
                writes.push(Array.from(value));
            }),
            haltUntilRead: vi.fn(async () => ['XRPBATCH_DONE']),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);
        const buildPath = vi.spyOn(commands, 'buildPath').mockResolvedValue(undefined);

        await commands.uploadFileBatch([
            { path: '/lib/MultiAgentLib/a.py', content: 'abc' },
            { path: '/lib/MultiAgentLib/b.py', content: new Uint8Array([1, 2]) },
        ]);

        expect(connection.writeUtilityCmdRaw).toHaveBeenCalledOnce();
        const uploadScript = vi.mocked(connection.writeUtilityCmdRaw).mock.calls[0][0];
        expect(uploadScript).toContain('("/lib/MultiAgentLib/a.py", 3)');
        expect(uploadScript).toContain('("/lib/MultiAgentLib/b.py", 2)');
        expect(connection.startReaduntil).toHaveBeenCalledWith('XRPBATCH_DONE');
        expect(writes).toEqual([
            [97, 98, 99, 1],
            [2, 255, 255, 255],
        ]);
        expect(buildPath).toHaveBeenCalledOnce();
        expect(buildPath).toHaveBeenCalledWith('/lib/MultiAgentLib');
        expect(connection.getToNormal).toHaveBeenCalledOnce();
        expect(commands.BUSY).toBe(false);
    });

    it('does not enter Raw REPL just to build a root directory', async () => {
        const connection = {
            XRP_SEND_BLOCK_SIZE: 250,
            writeUtilityCmdRaw: vi.fn(async () => ['started']),
            writeToDevice: vi.fn(async () => undefined),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);
        const buildPath = vi.spyOn(commands, 'buildPath');

        await commands.uploadFile('/sender.py', 'print("hello")');

        expect(buildPath).not.toHaveBeenCalled();
        expect(connection.writeUtilityCmdRaw).toHaveBeenCalledOnce();
        expect(commands.BUSY).toBe(false);
    });

    it('does not verify an unchanged main.py twice', async () => {
        const commands = new CommandToXRPMgr(false);
        const uploadFile = vi.spyOn(commands, 'uploadFile').mockResolvedValue(undefined);
        const verify = vi.spyOn(commands, 'verifyUploadedFiles').mockResolvedValue(undefined);

        await commands.updateMainFile('/sender.py', false);
        await commands.updateMainFile('/sender.py', false);

        expect(uploadFile).toHaveBeenCalledOnce();
        expect(verify).toHaveBeenCalledTimes(2);
        expect(commands.BUSY).toBe(false);
    });

    it('releases the busy lock when BLE program execution fails', async () => {
        const connection = {
            goCommand: vi.fn(async () => {
                throw new Error('GATT write failed');
            }),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);

        await expect(commands.executeLines('print("test")', {
            refreshFilesystem: false,
            emitProgramExecuted: false,
        })).rejects.toThrow('GATT write failed');

        expect(commands.BUSY).toBe(false);
    });
});
