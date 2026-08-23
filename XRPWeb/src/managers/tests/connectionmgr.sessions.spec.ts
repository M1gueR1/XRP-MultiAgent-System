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
    it('prepares multi-robot targets sequentially and launches only after every target is ready', async () => {
        const order: string[] = [];
        const makeCommands = (alias: string) => ({
            BUSY: false,
            prepareForRun: vi.fn(async () => { order.push(`prepare-${alias}`); }),
            uploadFile: vi.fn(async () => { order.push(`upload-${alias}`); }),
            verifyUploadedFiles: vi.fn(async () => { order.push(`verify-${alias}`); }),
            updateMainFile: vi.fn(async () => {
                order.push(`main-${alias}`);
                return `print("${alias}")`;
            }),
            executeLines: vi.fn(async () => { order.push(`execute-${alias}`); }),
        });
        const connection = { isConnected: () => true };
        const firstCommands = makeCommands('a');
        const secondCommands = makeCommands('b');
        const first = {
            sessionId: 'usb-a',
            alias: 'XRP A',
            connection,
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            commands: firstCommands,
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const second = {
            ...first,
            sessionId: 'usb-b',
            alias: 'XRP B',
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
            activeUSBSessionId: null,
            activeBLESessionId: null,
            activeConnection: null,
        });

        await manager.runProgramOnRobots(
            [first.sessionId, second.sessionId],
            '/shared.py',
            'print("shared")',
        );

        expect(order).toEqual([
            'prepare-a',
            'prepare-b',
            'upload-a',
            'verify-a',
            'main-a',
            'upload-b',
            'verify-b',
            'main-b',
            'execute-a',
            'execute-b',
        ]);
    });

    it('runs each selected preferred program without uploading shared editor content', async () => {
        const order: string[] = [];
        const makeCommands = (alias: string) => ({
            BUSY: false,
            prepareForRun: vi.fn(async () => { order.push(`prepare-${alias}`); }),
            getFileContents: vi.fn(async () => {
                order.push(`read-${alias}`);
                return Array.from(new TextEncoder().encode(`print("${alias}")`));
            }),
            uploadFile: vi.fn(async () => { order.push(`upload-${alias}`); }),
            updateMainFile: vi.fn(async (path: string) => {
                order.push(`main-${alias}:${path}`);
                return `print("${alias}")`;
            }),
            executeLines: vi.fn(async () => { order.push(`execute-${alias}`); }),
        });
        const connection = { isConnected: () => true };
        const firstCommands = makeCommands('a');
        const secondCommands = makeCommands('b');
        const first = {
            sessionId: 'usb-a',
            alias: 'XRP A',
            connection,
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            filesystemCache: JSON.stringify([{
                name: '/',
                path: '/',
                children: [{ name: 'a.py', path: '/', children: null }],
            }]),
            commands: firstCommands,
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const second = {
            ...first,
            sessionId: 'usb-b',
            alias: 'XRP B',
            filesystemCache: JSON.stringify([{
                name: '/',
                path: '/',
                children: [{ name: 'b.blocks', path: '/', children: null }],
            }]),
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
            activeUSBSessionId: null,
            activeBLESessionId: null,
            activeConnection: null,
        });

        await manager.runPreferredProgramsOnRobots([
            { sessionId: first.sessionId, path: '/a.py' },
            { sessionId: second.sessionId, path: '/b.blocks' },
        ]);

        expect(firstCommands.uploadFile).not.toHaveBeenCalled();
        expect(secondCommands.uploadFile).not.toHaveBeenCalled();
        expect(order).toEqual([
            'prepare-a',
            'prepare-b',
            'read-a',
            'read-b',
            'main-a:/a.py',
            'main-b:/b.blocks',
            'execute-a',
            'execute-b',
        ]);
    });

    it('lists Python and Blockly programs from nested XRP filesystem folders', async () => {
        const record = {
            sessionId: 'usb-a',
            alias: 'XRP A',
            connection: { isConnected: () => true },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            filesystemCache: JSON.stringify([{
                name: '/',
                path: '/',
                children: [
                    { name: 'main.py', path: '/', children: null },
                    { name: 'root.blocks', path: '/', children: null },
                    { name: 'notes.txt', path: '/', children: null },
                    {
                        name: 'lib',
                        path: '/',
                        children: [
                            { name: 'helper.py', path: '/lib', children: null },
                            { name: 'team.blocks', path: '/lib', children: null },
                            {
                                name: 'nested',
                                path: '/lib',
                                children: [
                                    { name: 'deep.py', path: '/lib/nested', children: null },
                                ],
                            },
                        ],
                    },
                ],
            }]),
            commands: { BUSY: false },
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map([[record.sessionId, record]]),
            bleSessions: new Map(),
            activeUSBSessionId: null,
            activeBLESessionId: null,
            activeConnection: null,
        });

        expect(manager.getUSBFleetSnapshot().sessions[0].programFiles).toEqual([
            '/lib/helper.py',
            '/lib/nested/deep.py',
            '/lib/team.blocks',
            '/root.blocks',
        ]);
    });

    it('coalesces concurrent BLE initialization callbacks into one initialization', async () => {
        const initialization = deferred();
        const performInitialization = vi.fn(() => initialization.promise);
        const record = {
            initializationPromise: undefined as Promise<void> | undefined,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            performBLESessionInitialization: performInitialization,
        });
        const initialize = (
            manager as unknown as {
                initializeBLESession: (session: typeof record) => Promise<void>;
            }
        ).initializeBLESession.bind(manager);

        const first = initialize(record);
        const second = initialize(record);
        await Promise.resolve();

        expect(performInitialization).toHaveBeenCalledOnce();
        initialization.resolve();
        await Promise.all([first, second]);
        expect(record.initializationPromise).toBeUndefined();
    });

    it('keeps the active IDE session and files visible while GATT is automatically reconnecting', async () => {
        const { BluetoothConnection } = await import('@/connections/bluetoothconnection');
        const { ConnectionState } = await import('@/connections/connection');
        const { ConnectionType } = await import('@/utils/types');
        const connection = Object.create(
            BluetoothConnection.prototype,
        ) as InstanceType<typeof BluetoothConnection>;
        vi.spyOn(connection, 'isRecovering').mockReturnValue(true);
        const record = {
            sessionId: 'ble-recovering',
            alias: 'XRP B',
            connection,
            state: 'connected',
            runtimeState: 'idle',
            initialized: false,
            resumeActive: false,
            terminalBuffer: 'Receiver ready\r\n',
            filesystemCache: '{"name":"/"}',
            commands: {},
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const emit = vi.fn();
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit },
            usbSessions: new Map(),
            bleSessions: new Map([[record.sessionId, record]]),
            activeUSBSessionId: null,
            activeBLESessionId: record.sessionId,
            activeConnection: connection,
        });

        await manager.connectCallback(
            ConnectionState.Disconnected,
            ConnectionType.BLUETOOTH,
            connection,
        );

        expect(record.state).toBe('reconnecting');
        expect(record.resumeActive).toBe(true);
        expect((manager as unknown as { activeBLESessionId: string | null }).activeBLESessionId)
            .toBe(record.sessionId);
        expect((
            manager as unknown as {
                activeConnection: InstanceType<typeof BluetoothConnection> | null;
            }
        ).activeConnection)
            .toBe(connection);
        expect(emit).not.toHaveBeenCalledWith(expect.anything(), '{}');
    });

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

    it('keeps terminal widget subscriptions isolated by XRP session', async () => {
        const connection = {
            isConnected: () => true,
            isBusy: () => false,
            writeToDevice: vi.fn(),
        };
        const first = {
            sessionId: 'usb-a',
            alias: 'XRP A',
            connection,
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: 'A history\r\n',
            commands: {},
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const second = {
            ...first,
            sessionId: 'usb-b',
            alias: 'XRP B',
            connection: {
                isConnected: () => true,
                isBusy: () => false,
                writeToDevice: vi.fn(),
            },
            terminalBuffer: 'B history\r\n',
        };

        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            usbSessions: new Map([
                [first.sessionId, first],
                [second.sessionId, second],
            ]),
            bleSessions: new Map(),
            activeUSBSessionId: second.sessionId,
            activeBLESessionId: null,
            activeConnection: second.connection,
            terminalListeners: new Map(),
        });

        const firstOutput: string[] = [];
        const secondOutput: string[] = [];
        const unsubscribeFirst = manager.subscribeRobotTerminal(first.sessionId, (data) => firstOutput.push(data));
        const unsubscribeSecond = manager.subscribeRobotTerminal(second.sessionId, (data) => secondOutput.push(data));

        expect(manager.getRobotTerminalBuffer(first.sessionId)).toBe('A history\r\n');
        expect(manager.getRobotTerminalBuffer(second.sessionId)).toBe('B history\r\n');

        manager.appendRobotTerminalBuffer(first.sessionId, 'A live\r\n');
        expect(firstOutput).toEqual(['A live\r\n']);
        expect(secondOutput).toEqual([]);

        manager.appendRobotTerminalBuffer(second.sessionId, 'B live\r\n');
        expect(firstOutput).toEqual(['A live\r\n']);
        expect(secondOutput).toEqual(['B live\r\n']);

        unsubscribeFirst();
        manager.appendRobotTerminalBuffer(first.sessionId, 'A after close\r\n');
        expect(firstOutput).toEqual(['A live\r\n']);

        unsubscribeSecond();
    });

    it('writes terminal input to the requested XRP instead of the active IDE robot', async () => {
        const firstConnection = {
            isConnected: () => true,
            isBusy: () => false,
            writeToDevice: vi.fn(),
        };
        const secondConnection = {
            isConnected: () => true,
            isBusy: () => false,
            writeToDevice: vi.fn(),
        };
        const first = {
            sessionId: 'usb-a',
            alias: 'XRP A',
            connection: firstConnection,
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            commands: {},
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const second = {
            ...first,
            sessionId: 'usb-b',
            alias: 'XRP B',
            connection: secondConnection,
        };

        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            usbSessions: new Map([
                [first.sessionId, first],
                [second.sessionId, second],
            ]),
            bleSessions: new Map(),
            activeUSBSessionId: second.sessionId,
            activeBLESessionId: null,
            activeConnection: secondConnection,
        });

        manager.writeRobotTerminalData(first.sessionId, 'print("A")\r');

        expect(firstConnection.writeToDevice).toHaveBeenCalledWith('print("A")\r');
        expect(secondConnection.writeToDevice).not.toHaveBeenCalled();

        firstConnection.isBusy = () => true;
        manager.writeRobotTerminalData(first.sessionId, 'ignored');
        expect(firstConnection.writeToDevice).toHaveBeenCalledTimes(1);
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

    it('preloads the Bluetooth team library over USB without preparing or running main.py', async () => {
        const commands = {
            BUSY: false,
            uploadFileBatch: vi.fn(async (
                _files: ReadonlyArray<{ path: string; content: string | Uint8Array }>,
            ) => undefined),
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn()
                .mockRejectedValueOnce(new Error('bundle manifest missing'))
                .mockResolvedValue(undefined),
            updateMainFile: vi.fn(async () => ''),
            executeLines: vi.fn(async () => undefined),
        };
        const usb = {
            sessionId: 'usb-preload',
            alias: 'XRP A',
            connection: {
                isConnected: () => true,
                hasRuntimeDataChannel: () => true,
            },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            error: undefined as string | undefined,
            commands,
            multiAgentLibraryInstalled: false,
            teamTransportConfigured: false,
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map([[usb.sessionId, usb]]),
            bleSessions: new Map(),
            activeUSBSessionId: usb.sessionId,
            activeBLESessionId: null,
        });

        await manager.prepareUSBRobotForBluetooth(usb.sessionId);

        expect(commands.uploadFileBatch).toHaveBeenCalledOnce();
        expect(commands.uploadFileBatch.mock.calls[0][0]).toContainEqual({
            path: '/lib/MultiAgentLib/_transport_config.py',
            content: 'TRANSPORT = "bluetooth_uart"\n',
        });
        expect(commands.updateMainFile).not.toHaveBeenCalled();
        expect(commands.executeLines).not.toHaveBeenCalled();
        expect(usb.multiAgentLibraryInstalled).toBe(true);
        expect(usb.teamTransportConfigured).toBe(true);
        expect((usb as typeof usb & { teamTransportMode?: string }).teamTransportMode).toBe('bluetooth_uart');
    });

    it('switches the cached transport configuration when moving between Bluetooth preparation and USB runs', async () => {
        const commands = {
            BUSY: false,
            uploadFileBatch: vi.fn(async () => undefined),
            uploadFile: vi.fn(async () => undefined),
            verifyUploadedFiles: vi.fn(async () => undefined),
        };
        const usb = {
            sessionId: 'usb-transport-switch',
            alias: 'XRP A',
            connection: {
                isConnected: () => true,
                hasRuntimeDataChannel: () => true,
            },
            state: 'connected',
            runtimeState: 'idle',
            initialized: true,
            terminalBuffer: '',
            commands,
            multiAgentLibraryInstalled: true,
            teamTransportConfigured: true,
            teamTransportMode: 'usb',
        };
        const manager = Object.create(
            (await import('@/managers/connectionmgr')).default.prototype,
        ) as ConnectionMgr & Record<string, unknown>;
        Object.assign(manager, {
            appMgr: { emit: vi.fn() },
            usbSessions: new Map([[usb.sessionId, usb]]),
            bleSessions: new Map(),
            activeUSBSessionId: usb.sessionId,
            activeBLESessionId: null,
        });

        await manager.prepareUSBRobotForBluetooth(usb.sessionId);
        await (
            manager as unknown as {
                prepareTeamCommunication: (sessionIds: string[]) => Promise<void>;
            }
        ).prepareTeamCommunication([usb.sessionId]);

        expect(commands.uploadFile).toHaveBeenNthCalledWith(
            1,
            '/lib/MultiAgentLib/_transport_config.py',
            'TRANSPORT = "bluetooth_uart"\n',
            false,
        );
        expect(commands.uploadFile).toHaveBeenNthCalledWith(
            2,
            '/lib/MultiAgentLib/_transport_config.py',
            'TRANSPORT = "usb"\n',
            false,
        );
        expect(usb.teamTransportMode).toBe('usb');
    });
});