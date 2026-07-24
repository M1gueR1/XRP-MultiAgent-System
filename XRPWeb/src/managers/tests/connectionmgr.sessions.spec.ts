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

    it('routes late terminal output to the originating robot instead of the active robot', async () => {
        const receiver = {
            sessionId: 'ble-b',
            alias: 'XRP B',
            connection: { isConnected: () => true },
            state: 'connected',
            runtimeState: 'running',
            initialized: true,
            resumeActive: false,
            terminalBuffer: '',
            commands: {},
            multiAgentLibraryInstalled: true,
            teamTransportConfigured: true,
        };
        const sender = {
            ...receiver,
            sessionId: 'ble-a',
            alias: 'XRP A',
            runtimeState: 'idle',
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            usbSessions: new Map(),
            bleSessions: new Map([
                [receiver.sessionId, receiver],
                [sender.sessionId, sender],
            ]),
            activeUSBSessionId: null,
            activeBLESessionId: sender.sessionId,
            activeConnection: sender.connection,
        });

        manager.appendRobotTerminalBuffer(receiver.sessionId, 'Receiver message\r\n');

        expect(receiver.terminalBuffer).toContain('Receiver message');
        expect(sender.terminalBuffer).toBe('');
    });

    it('keeps a pending receiver on its original robot while a sender starts in the newly active IDE', async () => {
        const upload = deferred();
        const firstCommands = {
            BUSY: false,
            uploadFile: vi.fn(() => upload.promise),
            verifyUploadedFiles: vi.fn(async () => undefined),
            updateMainFile: vi.fn(async () => 'print("receiver")'),
            executeLines: vi.fn(async () => undefined),
            getOnBoardFSTree: vi.fn(async () => '{}'),
        };
        const secondCommands = {
            BUSY: false,
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn(async () => undefined),
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

    it('uses the same verified run pipeline for a Bluetooth IDE robot', async () => {
        const commands = {
            BUSY: false,
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn(async () => undefined),
            updateMainFile: vi.fn(async () => 'print("sender")'),
            executeLines: vi.fn(async () => undefined),
            getOnBoardFSTree: vi.fn(async () => '{}'),
        };
        const connection = { isConnected: () => true };
        const bluetooth = {
            sessionId: 'ble-a',
            alias: 'XRP A',
            connection,
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            resumeActive: false,
            terminalBuffer: '',
            commands,
            multiAgentLibraryInstalled: true,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map(),
            bleSessions: new Map([[bluetooth.sessionId, bluetooth]]),
            activeUSBSessionId: null,
            activeBLESessionId: bluetooth.sessionId,
            activeConnection: connection,
        });

        await manager.runProgramOnRobots(
            [bluetooth.sessionId],
            '/sender.py',
            'print("sender")',
        );

        expect(commands.uploadFile).toHaveBeenCalledWith(
            '/sender.py',
            'print("sender")',
            false,
        );
        expect(commands.verifyUploadedFiles).toHaveBeenCalledWith([{
            path: '/sender.py',
            byteLength: new TextEncoder().encode('print("sender")').length,
        }]);
        expect(commands.executeLines).toHaveBeenCalledOnce();
        expect(bluetooth.runtimeState).toBe('idle');
    });

    it('starts the team handshake only after BLE uploads and main preparation finish', async () => {
        const order: string[] = [];
        const commands = {
            BUSY: false,
            uploadFile: vi.fn(async () => { order.push('upload'); }),
            verifyUploadedFiles: vi.fn(async () => { order.push('verify'); }),
            updateMainFile: vi.fn(async () => {
                order.push('main');
                return 'print("receiver")';
            }),
            executeLines: vi.fn(async () => { order.push('execute'); }),
        };
        const bluetooth = {
            sessionId: 'ble-b',
            alias: 'XRP B',
            connection: { isConnected: () => true },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            resumeActive: false,
            terminalBuffer: '',
            error: undefined as string | undefined,
            commands,
            multiAgentLibraryInstalled: true,
            teamTransportConfigured: true,
        };
        const prepareFiles = vi.fn(async () => { order.push('team-files'); });
        const prepareRuntime = vi.fn(async () => { order.push('team-runtime'); });
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map(),
            bleSessions: new Map([[bluetooth.sessionId, bluetooth]]),
            activeUSBSessionId: null,
            activeBLESessionId: null,
            activeConnection: null,
            prepareTeamCommunication: prepareFiles,
            prepareTeamRuntime: prepareRuntime,
        });

        await manager.runProgramOnRobots(
            [bluetooth.sessionId],
            '/receiver.py',
            'from MultiAgentLib.team import get_default_team',
        );

        expect(order).toEqual([
            'team-files',
            'upload',
            'verify',
            'main',
            'team-runtime',
            'execute',
        ]);
    });

    it('reports the exact BLE Run phase instead of silently returning to idle', async () => {
        const commands = {
            BUSY: false,
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn(async () => {
                throw new Error('empty verification response');
            }),
        };
        const bluetooth = {
            sessionId: 'ble-a',
            alias: 'XRP A',
            connection: { isConnected: () => true },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            resumeActive: false,
            terminalBuffer: '',
            error: undefined as string | undefined,
            commands,
            multiAgentLibraryInstalled: true,
            teamTransportConfigured: true,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map(),
            bleSessions: new Map([[bluetooth.sessionId, bluetooth]]),
            activeUSBSessionId: null,
            activeBLESessionId: null,
            activeConnection: null,
        });

        await expect(manager.runProgramOnRobots(
            [bluetooth.sessionId],
            '/emisor.py',
            'print("Sender starting")',
        )).rejects.toThrow(
            'XRP A Run failed while verifying /emisor.py: empty verification response',
        );

        expect(bluetooth.runtimeState).toBe('idle');
        expect(bluetooth.error).toContain('verifying /emisor.py');
    });

    it('selects Bluetooth UART framing for XRP firmware without DATA characteristics', async () => {
        const commands = {
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn(async () => undefined),
        };
        const bluetooth = {
            sessionId: 'ble-legacy',
            alias: 'XRP-724e7',
            connection: {
                hasRuntimeDataChannel: () => true,
                hasDedicatedRuntimeDataChannel: () => false,
            },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            resumeActive: false,
            terminalBuffer: '',
            commands,
            multiAgentLibraryInstalled: true,
            teamTransportConfigured: false,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            usbSessions: new Map(),
            bleSessions: new Map([[bluetooth.sessionId, bluetooth]]),
        });

        await (
            manager as unknown as {
                prepareTeamCommunication: (sessionIds: string[]) => Promise<void>;
            }
        ).prepareTeamCommunication([bluetooth.sessionId]);

        expect(commands.uploadFile).toHaveBeenCalledWith(
            '/lib/MultiAgentLib/_transport_config.py',
            'TRANSPORT = "bluetooth_uart"\n',
            false,
        );
        expect(bluetooth.teamTransportConfigured).toBe(true);
    });

    it('installs MultiAgentLib as one batch and reuses the session cache', async () => {
        const commands = {
            uploadFileBatch: vi.fn(async (
                _files: ReadonlyArray<{ path: string; content: string | Uint8Array }>,
            ) => undefined),
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn()
                .mockRejectedValueOnce(new Error('bundle manifest missing'))
                .mockResolvedValue(undefined),
        };
        const bluetooth = {
            sessionId: 'ble-first-install',
            alias: 'XRP A',
            connection: {
                hasRuntimeDataChannel: () => true,
                hasDedicatedRuntimeDataChannel: () => false,
            },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            resumeActive: false,
            terminalBuffer: '',
            commands,
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            usbSessions: new Map(),
            bleSessions: new Map([[bluetooth.sessionId, bluetooth]]),
        });
        const prepare = (
            manager as unknown as {
                prepareTeamCommunication: (sessionIds: string[]) => Promise<void>;
            }
        ).prepareTeamCommunication.bind(manager);

        await prepare([bluetooth.sessionId]);
        await prepare([bluetooth.sessionId]);

        expect(commands.uploadFileBatch).toHaveBeenCalledOnce();
        expect(commands.uploadFileBatch.mock.calls[0][0]).toHaveLength(12);
        expect(commands.uploadFile).not.toHaveBeenCalled();
        expect(bluetooth.multiAgentLibraryInstalled).toBe(true);
        expect(bluetooth.teamTransportConfigured).toBe(true);
    });
});
