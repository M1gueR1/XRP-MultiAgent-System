import type ConnectionMgr from '@/managers/connectionmgr';
import { describe, expect, it, vi } from 'vitest';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('ConnectionMgr session-bound runs', () => {
    it('keeps terminal history available across repeated IDE switches', async () => {
        const first = {
            sessionId: 'usb-b',
            alias: 'XRP B',
            connection: { isConnected: () => true },
            state: 'connected',
            runtimeState: 'running',
            initialized: true,
            terminalBuffer: 'Receiver ready\r\n',
            commands: {},
            multiAgentLibraryInstalled: true,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            usbSessions: new Map([[first.sessionId, first]]),
            bleSessions: new Map(),
            activeUSBSessionId: first.sessionId,
            activeBLESessionId: null,
            activeConnection: first.connection,
        });

        expect(manager.consumeActiveRobotTerminalBuffer()).toBe('Receiver ready\r\n');
        expect(manager.consumeActiveRobotTerminalBuffer()).toBe('Receiver ready\r\n');

        manager.appendActiveRobotTerminalBuffer('Message received: Hiiii from A\r\n');

        expect(manager.consumeActiveRobotTerminalBuffer()).toContain('Receiver ready');
        expect(manager.consumeActiveRobotTerminalBuffer()).toContain('Message received: Hiiii from A');
    });

    it('keeps a pending receiver on its original robot while a sender starts in the newly active IDE', async () => {
        const upload = deferred();
        const firstCommands = {
            BUSY: false,
            uploadFile: vi.fn(() => upload.promise),
            updateMainFile: vi.fn(async () => 'print("receiver")'),
            executeLines: vi.fn(async () => undefined),
            getOnBoardFSTree: vi.fn(async () => '{}'),
        };
        const secondCommands = {
            BUSY: false,
            uploadFile: vi.fn(async () => undefined),
            updateMainFile: vi.fn(async () => 'print("sender")'),
            executeLines: vi.fn(async () => undefined),
            getOnBoardFSTree: vi.fn(async () => '{}'),
        };
        const connected = { isConnected: () => true };
        const first = {
            sessionId: 'usb-b',
            alias: 'XRP B',
            connection: connected,
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            commands: firstCommands,
            multiAgentLibraryInstalled: true,
        };
        const second = {
            ...first,
            sessionId: 'usb-a',
            alias: 'XRP A',
            runtimeState: 'idle',
            commands: secondCommands,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map([
                [first.sessionId, first],
                [second.sessionId, second],
            ]),
            bleSessions: new Map(),
            activeUSBSessionId: first.sessionId,
            activeBLESessionId: null,
            activeConnection: first.connection,
        });

        const run = manager.runProgramOnRobots(
            [first.sessionId],
            '/receiver.py',
            'print("receiver")',
        );
        await vi.waitFor(() => expect(first.runtimeState).toBe('starting'));

        Object.assign(manager, {
            activeUSBSessionId: second.sessionId,
            activeConnection: second.connection,
        });
        await manager.runProgramOnRobots(
            [second.sessionId],
            '/sender.py',
            'print("sender")',
        );
        upload.resolve();
        await run;

        expect(firstCommands.uploadFile).toHaveBeenCalledOnce();
        expect(firstCommands.executeLines).toHaveBeenCalledOnce();
        expect(secondCommands.uploadFile).toHaveBeenCalledOnce();
        expect(secondCommands.executeLines).toHaveBeenCalledOnce();
        expect(first.runtimeState).toBe('idle');
        expect(second.runtimeState).toBe('idle');
    });
});
