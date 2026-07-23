import AppMgr, { EventType } from '@/managers/appmgr';
import { ConnectionCMD, ConnectionType } from '@/utils/types';
import Connection, { ConnectionState } from '@/connections/connection';
import { USBConnection } from '@/connections/usbconnection';
import { BluetoothConnection } from '@/connections/bluetoothconnection';
import type {
    USBRobotFleetSnapshot,
    USBRobotSessionSnapshot,
    USBRobotSessionState,
} from '@/connections/usbFleetTypes';
import type {
    BLERobotFleetSnapshot,
    BLERobotSessionSnapshot,
    BLERobotSessionState,
} from '@/connections/bluetoothFleetTypes';
import { CommandToXRPMgr } from './commandstoxrpmgr';
import PluginMgr from './pluginmgr';
import type { IDERobotTargetSnapshot } from '@/connections/ideRobotTypes';
import {
    BluetoothIDETransport,
    USBIDETransport,
    getRobotFleetManager,
    MULTI_AGENT_LIBRARY_FILES,
    programUsesTeamCommunication,
} from '@/multiagent';

type IDERobotRuntimeState = 'idle' | 'running';

interface USBRobotSessionRecord {
    sessionId: string;
    alias: string;
    connection: USBConnection;
    state: USBRobotSessionState;
    runtimeState: IDERobotRuntimeState;
    initialized: boolean;
    usbVendorId?: number;
    usbProductId?: number;
    lastRunStartedAt?: number;
    lastRunFinishedAt?: number;
    terminalBuffer: string;
    filesystemCache?: string;
    error?: string;
    commands: CommandToXRPMgr;
    multiAgentLibraryInstalled: boolean;
}

interface BLERobotSessionRecord {
    sessionId: string;
    alias: string;
    connection: BluetoothConnection;
    state: BLERobotSessionState;
    runtimeState: IDERobotRuntimeState;
    initialized: boolean;
    resumeActive: boolean;
    deviceName?: string;
    browserDeviceId?: string;
    lastRunStartedAt?: number;
    lastRunFinishedAt?: number;
    terminalBuffer: string;
    filesystemCache?: string;
    error?: string;
    commands: CommandToXRPMgr;
    multiAgentLibraryInstalled: boolean;
}

type IDERobotSessionRecord = USBRobotSessionRecord | BLERobotSessionRecord;

/**
 * Owns the legacy active connection and the USB fleet. Only one fleet member is
 * exposed to the existing IDE at a time, while every Web Serial port remains open.
 */
export default class ConnectionMgr {
    private appMgr: AppMgr;
    private cmdToXRPMgr: CommandToXRPMgr = CommandToXRPMgr.getInstance();
    private pluginMgr: PluginMgr = PluginMgr.getInstance();
    private connections: Connection[] = [];
    private activeConnection: Connection | null = null;
    private usbSessions = new Map<string, USBRobotSessionRecord>();
    private activeUSBSessionId: string | null = null;
    private usbSessionSequence = 0;
    private switchingUSBSession = false;
    private bleSessions = new Map<string, BLERobotSessionRecord>();
    private activeBLESessionId: string | null = null;
    private bleSessionSequence = 0;
    private switchingBLESession = false;
    private xrpID: string | undefined = undefined;

    constructor(appMgr: AppMgr) {
        this.appMgr = appMgr;

        // Preserve the original auto-connect behavior for the first USB robot.
        this.connections[ConnectionType.USB] = new USBConnection(this);
        this.cmdToXRPMgr.setConnection(this.connections[ConnectionType.USB]);
        this.activeConnection = this.connections[ConnectionType.USB];
        this.connections[ConnectionType.BLUETOOTH] = new BluetoothConnection(this);

        this.appMgr.on(EventType.EVENT_CONNECTION, (subType: string) => {
            switch (subType) {
                case ConnectionCMD.CONNECT_USB:
                    void this.connections[ConnectionType.USB].connect();
                    break;
                case ConnectionCMD.CONNECT_BLUETOOTH:
                    void this.connections[ConnectionType.BLUETOOTH].connect();
                    break;
            }
        });
    }

    public async addUSBRobot(): Promise<void> {
        if (!('serial' in navigator)) {
            throw new Error('Web Serial is not available. Use Chrome or Edge on localhost or HTTPS.');
        }
        if (this.switchingUSBSession || this.cmdToXRPMgr.BUSY) {
            throw new Error('The active XRP is busy. Wait for the current operation to finish.');
        }

        const connection = new USBConnection(this, { manualOnly: true });
        try {
            await connection.connect();
            if (!connection.isConnected()) {
                throw new Error('No USB XRP was selected.');
            }
        } catch (error) {
            const record = this.findUSBSession(connection);
            if (record && !connection.isConnected()) {
                this.usbSessions.delete(record.sessionId);
                this.emitUSBFleet();
            }
            throw error;
        }
    }

    public async selectUSBRobot(sessionId: string): Promise<void> {
        const record = this.requireUSBSession(sessionId);
        if (!record.connection.isConnected()) {
            throw new Error(`${record.alias} is disconnected.`);
        }
        if (this.switchingUSBSession) {
            throw new Error('The active XRP is busy. Wait before changing robots.');
        }
        if (sessionId === this.activeUSBSessionId && this.activeConnection === record.connection) {
            if (record.runtimeState !== 'running') {
                await this.refreshFilesystemForRecord(record);
            } else {
                this.emitCachedFilesystem(record);
            }
            return;
        }

        this.switchingUSBSession = true;
        try {
            this.activateUSBRecord(record);
            this.appMgr.emit(EventType.EVENT_CONNECTION_STATUS, ConnectionState.Connected.toString());
            if (record.runtimeState === 'running') {
                this.emitCachedFilesystem(record);
            } else {
                await this.refreshFilesystemForRecord(record);
            }
        } finally {
            this.switchingUSBSession = false;
            this.emitUSBFleet();
        }
    }

    public async reconnectUSBRobot(sessionId: string): Promise<void> {
        const record = this.requireUSBSession(sessionId);
        record.state = 'connecting';
        record.error = undefined;
        this.emitUSBFleet();
        if (record.connection.isConnected()) {
            await this.initializeUSBSession(record);
        } else {
            await record.connection.reconnect();
        }
        if (!record.connection.isConnected()) {
            record.state = 'disconnected';
            this.emitUSBFleet();
            throw new Error(`Could not reconnect ${record.alias}.`);
        }
    }

    public async disconnectUSBRobot(sessionId: string): Promise<void> {
        const record = this.requireUSBSession(sessionId);
        await record.connection.disconnect();
    }

    public async removeUSBRobot(sessionId: string): Promise<void> {
        const record = this.requireUSBSession(sessionId);
        if (record.connection.isConnected()) await record.connection.disconnect();
        this.usbSessions.delete(sessionId);
        await getRobotFleetManager().removeExternalRobot(this.runtimeExternalKey('usb', sessionId));
        if (this.activeUSBSessionId === sessionId) this.activeUSBSessionId = null;
        this.emitUSBFleet();
    }

    public renameUSBRobot(sessionId: string, alias: string): void {
        const record = this.requireUSBSession(sessionId);
        const normalized = this.normalizeTeamAlias(alias);
        if (!normalized) throw new Error('Robot alias cannot be empty.');
        record.alias = normalized;
        getRobotFleetManager().renameExternalRobot(this.runtimeExternalKey('usb', sessionId), normalized);
        this.emitUSBFleet();
    }

    public async disconnectAllUSB(): Promise<void> {
        const connected = [...this.usbSessions.values()].filter((record) => record.connection.isConnected());
        for (const record of connected) await record.connection.disconnect();
    }

    public getUSBFleetSnapshot(): USBRobotFleetSnapshot {
        const sessions: USBRobotSessionSnapshot[] = [...this.usbSessions.values()].map((record) => ({
            sessionId: record.sessionId,
            alias: record.alias,
            state: record.state,
            runtimeState: record.runtimeState,
            active: record.sessionId === this.activeUSBSessionId,
            usbVendorId: record.usbVendorId,
            usbProductId: record.usbProductId,
            lastRunStartedAt: record.lastRunStartedAt,
            lastRunFinishedAt: record.lastRunFinishedAt,
            error: record.error,
        }));
        return {
            supported: typeof navigator !== 'undefined' && 'serial' in navigator,
            activeSessionId: this.activeUSBSessionId,
            sessions,
        };
    }

    public getActiveUSBSessionId(): string | null {
        return this.activeUSBSessionId;
    }

    public isUSBPortClaimed(port: SerialPort, requester: USBConnection): boolean {
        return [...this.usbSessions.values()].some((record) =>
            record.connection !== requester && record.connection.getPortHandle() === port,
        );
    }

    public async addBluetoothRobot(): Promise<void> {
        if (!navigator.bluetooth) {
            throw new Error('Web Bluetooth is not available. Use Chrome or Edge on localhost or HTTPS.');
        }
        if (this.switchingBLESession || this.cmdToXRPMgr.BUSY) {
            throw new Error('The active XRP is busy. Wait for the current operation to finish.');
        }

        const connection = new BluetoothConnection(this, { autoReconnect: true });
        try {
            await connection.connect();
            if (!connection.isConnected()) throw new Error('No Bluetooth XRP was selected.');
        } catch (error) {
            const record = this.findBLESession(connection);
            if (record && !connection.isConnected()) {
                this.bleSessions.delete(record.sessionId);
                this.emitBLEFleet();
            }
            throw error;
        }
    }

    public async selectBluetoothRobot(sessionId: string): Promise<void> {
        const record = this.requireBLESession(sessionId);
        if (!record.connection.isConnected()) throw new Error(`${record.alias} is disconnected.`);
        if (this.switchingBLESession) {
            throw new Error('The active XRP is busy. Wait before changing robots.');
        }

        this.switchingBLESession = true;
        try {
            this.activateBLERecord(record);
            this.appMgr.emit(EventType.EVENT_CONNECTION_STATUS, ConnectionState.Connected.toString());
            if (record.runtimeState === 'running') {
                this.emitCachedFilesystem(record);
            } else {
                await this.refreshFilesystemForRecord(record);
            }
            record.state = 'connected';
            record.error = undefined;
        } finally {
            this.switchingBLESession = false;
            this.emitBLEFleet();
        }
    }

    public async reconnectBluetoothRobot(sessionId: string): Promise<void> {
        const record = this.requireBLESession(sessionId);
        record.state = 'connecting';
        record.error = undefined;
        this.emitBLEFleet();
        if (record.connection.isConnected()) {
            await this.initializeBLESession(record);
        } else {
            await record.connection.reconnect();
        }
        if (!record.connection.isConnected()) throw new Error(`Could not reconnect ${record.alias}.`);
    }

    public async disconnectBluetoothRobot(sessionId: string): Promise<void> {
        await this.requireBLESession(sessionId).connection.disconnect();
    }

    public async removeBluetoothRobot(sessionId: string): Promise<void> {
        const record = this.requireBLESession(sessionId);
        if (record.connection.isConnected()) await record.connection.disconnect();
        this.bleSessions.delete(sessionId);
        await getRobotFleetManager().removeExternalRobot(this.runtimeExternalKey('bluetooth', sessionId));
        if (this.activeBLESessionId === sessionId) this.activeBLESessionId = null;
        this.emitBLEFleet();
    }

    public renameBluetoothRobot(sessionId: string, alias: string): void {
        const record = this.requireBLESession(sessionId);
        const normalized = this.normalizeTeamAlias(alias);
        if (!normalized) throw new Error('Robot alias cannot be empty.');
        record.alias = normalized;
        getRobotFleetManager().renameExternalRobot(this.runtimeExternalKey('bluetooth', sessionId), normalized);
        this.emitBLEFleet();
    }

    public async disconnectAllBluetooth(): Promise<void> {
        const connected = [...this.bleSessions.values()].filter((record) => record.connection.isConnected());
        for (const record of connected) await record.connection.disconnect();
    }

    public getBLEFleetSnapshot(): BLERobotFleetSnapshot {
        const sessions: BLERobotSessionSnapshot[] = [...this.bleSessions.values()].map((record) => ({
            sessionId: record.sessionId,
            alias: record.alias,
            state: record.state,
            runtimeState: record.runtimeState,
            active: record.sessionId === this.activeBLESessionId,
            deviceName: record.deviceName,
            browserDeviceId: record.browserDeviceId,
            lastRunStartedAt: record.lastRunStartedAt,
            lastRunFinishedAt: record.lastRunFinishedAt,
            error: record.error,
        }));
        return {
            supported: typeof navigator !== 'undefined' && Boolean(navigator.bluetooth),
            activeSessionId: this.activeBLESessionId,
            sessions,
        };
    }

    public isBluetoothDeviceClaimed(device: BluetoothDevice, requester: BluetoothConnection): boolean {
        return [...this.bleSessions.values()].some((record) =>
            record.connection !== requester && record.connection.getDevice()?.id === device.id,
        );
    }

    public getActiveRobotSessionId(): string | null {
        return this.activeUSBSessionId ?? this.activeBLESessionId;
    }

    public getActiveRobotRuntimeState(): IDERobotRuntimeState {
        const active = this.getActiveRobotRecord();
        return active?.runtimeState ?? 'idle';
    }

    public getActiveRobotTerminalBuffer(): string {
        return this.getActiveRobotRecord()?.terminalBuffer ?? '';
    }

    public consumeActiveRobotTerminalBuffer(): string {
        const active = this.getActiveRobotRecord();
        if (!active) return '';
        const buffer = active.terminalBuffer;
        active.terminalBuffer = '';
        return buffer;
    }

    public markActiveRobotRuntimeState(runtimeState: IDERobotRuntimeState): void {
        const active = this.getActiveRobotRecord();
        if (!active) return;
        this.setRobotRuntimeState(active, runtimeState);
    }

    public getConnectedIDERobots(sessionIds?: string[]): IDERobotTargetSnapshot[] {
        const requested = sessionIds ? new Set(sessionIds) : null;
        const usb = [...this.usbSessions.values()]
            .filter((record) => record.connection.isConnected() && (!requested || requested.has(record.sessionId)))
            .map((record): IDERobotTargetSnapshot => ({
                sessionId: record.sessionId,
                alias: record.alias,
                transport: 'usb',
            }));
        const bluetooth = [...this.bleSessions.values()]
            .filter((record) => record.connection.isConnected() && (!requested || requested.has(record.sessionId)))
            .map((record): IDERobotTargetSnapshot => ({
                sessionId: record.sessionId,
                alias: record.alias,
                transport: 'bluetooth',
            }));
        return [...usb, ...bluetooth];
    }

    public async saveFileToRobots(
        sessionIds: string[],
        path: string,
        content: string,
    ): Promise<void> {
        const targets = this.resolveCommandTargets(sessionIds);
        await Promise.all(targets.map(({ commands }) => commands.uploadFile(path, content, false)));
        if (sessionIds.includes(this.getActiveRobotSessionId() ?? '')) {
            const active = this.getActiveRobotRecord();
            if (active) {
                if (active.runtimeState !== 'running') {
                    await this.refreshFilesystemForRecord(active);
                } else {
                    this.emitCachedFilesystem(active);
                }
            }
        }
    }

    public async runProgramOnRobots(
        sessionIds: string[],
        path: string,
        content: string,
    ): Promise<void> {
        const targets = this.resolveCommandTargets(sessionIds);
        if (programUsesTeamCommunication(content)) {
            await this.prepareTeamCommunication(sessionIds);
        }
        await Promise.all(targets.map(({ commands }) => commands.uploadFile(path, content, false)));
        await Promise.all(targets.map(async ({ sessionId, commands }) => {
            const lines = await commands.updateMainFile(path, false);
            const record = this.getRobotRecord(sessionId);
            if (record) this.setRobotRuntimeState(record, 'running');
            try {
                await commands.executeLines(lines, { refreshFilesystem: false, emitProgramExecuted: false });
            } finally {
                if (record) this.setRobotRuntimeState(record, 'idle');
            }
        }));
        if (sessionIds.includes(this.getActiveRobotSessionId() ?? '')) {
            const active = this.getActiveRobotRecord();
            if (active) {
                if (active.runtimeState !== 'running') {
                    await this.refreshFilesystemForRecord(active);
                } else {
                    this.emitCachedFilesystem(active);
                }
            }
        }
    }

    public async stopProgramsOnRobots(sessionIds: string[]): Promise<void> {
        const targets = [...new Set(sessionIds)].flatMap((sessionId) => {
            const usb = this.usbSessions.get(sessionId);
            if (usb?.connection.isConnected()) return [{ sessionId, commands: usb.commands }];
            const bluetooth = this.bleSessions.get(sessionId);
            if (bluetooth?.connection.isConnected()) return [{ sessionId, commands: bluetooth.commands }];
            return [];
        });
        await Promise.all(targets.map(async ({ sessionId, commands }) => {
            try {
                await commands.stopProgram();
            } finally {
                const record = this.getRobotRecord(sessionId);
                if (record) this.setRobotRuntimeState(record, 'idle');
            }
        }));
    }

    private resolveCommandTargets(
        sessionIds: string[],
        requireConnected: boolean = true,
    ): Array<{ sessionId: string; commands: CommandToXRPMgr }> {
        const uniqueIds = [...new Set(sessionIds)];
        if (uniqueIds.length === 0) throw new Error('No XRP robots are assigned to this multi-robot tab.');
        return uniqueIds.map((sessionId) => {
            const usb = this.usbSessions.get(sessionId);
            if (usb) {
                if (requireConnected && !usb.connection.isConnected()) throw new Error(`${usb.alias} is disconnected.`);
                if (usb.commands.BUSY) {
                    throw new Error(`${usb.alias} is busy. Wait for its current IDE operation to finish.`);
                }
                return { sessionId, commands: usb.commands };
            }
            const bluetooth = this.bleSessions.get(sessionId);
            if (bluetooth) {
                if (requireConnected && !bluetooth.connection.isConnected()) throw new Error(`${bluetooth.alias} is disconnected.`);
                if (bluetooth.commands.BUSY) {
                    throw new Error(`${bluetooth.alias} is busy. Wait for its current IDE operation to finish.`);
                }
                return { sessionId, commands: bluetooth.commands };
            }
            throw new Error(`Unknown XRP session: ${sessionId}`);
        });
    }

    private async prepareTeamCommunication(sessionIds: string[]): Promise<void> {
        const uniqueIds = [...new Set(sessionIds)];
        const usbRecords: USBRobotSessionRecord[] = [];
        const bluetoothRecords: BLERobotSessionRecord[] = [];
        for (const sessionId of uniqueIds) {
            const usb = this.usbSessions.get(sessionId);
            if (usb) {
                if (!usb.connection.hasRuntimeDataChannel()) {
                    throw new Error(`${usb.alias} USB serial channel is unavailable for team messaging.`);
                }
                usbRecords.push(usb);
                continue;
            }
            const bluetooth = this.bleSessions.get(sessionId);
            if (!bluetooth) throw new Error(`Unknown XRP session: ${sessionId}`);
            if (!bluetooth.connection.hasRuntimeDataChannel()) {
                throw new Error(`${bluetooth.alias} firmware does not expose the BLE DATA channel required for team messaging.`);
            }
            bluetoothRecords.push(bluetooth);
        }

        await Promise.all([...usbRecords, ...bluetoothRecords].map(async (record) => {
            if (!record.multiAgentLibraryInstalled) {
                for (const file of MULTI_AGENT_LIBRARY_FILES) {
                    await record.commands.uploadFile(file.path, file.content, false);
                }
                record.multiAgentLibraryInstalled = true;
            }
        }));

        await Promise.all(usbRecords.map((record) => record.commands.uploadFile(
            '/lib/MultiAgentLib/_transport_config.py',
            'TRANSPORT = "usb"\n',
            false,
        )));
        await Promise.all(bluetoothRecords.map((record) => record.commands.uploadFile(
            '/lib/MultiAgentLib/_transport_config.py',
            'TRANSPORT = "bluetooth"\n',
            false,
        )));

        const fleet = getRobotFleetManager();
        await Promise.all(usbRecords.map((record) => fleet.attachExternalRobot(
            this.runtimeExternalKey('usb', record.sessionId),
            new USBIDETransport(record.connection),
            record.alias,
        )));
        await Promise.all(bluetoothRecords.map((record) => fleet.attachExternalRobot(
            this.runtimeExternalKey('bluetooth', record.sessionId),
            new BluetoothIDETransport(record.connection),
            record.alias,
        )));
        for (const record of usbRecords) {
            fleet.prepareExternalRobotRun(this.runtimeExternalKey('usb', record.sessionId));
        }
        for (const record of bluetoothRecords) {
            fleet.prepareExternalRobotRun(this.runtimeExternalKey('bluetooth', record.sessionId));
        }
    }

    private runtimeExternalKey(transport: 'usb' | 'bluetooth', sessionId: string): string {
        return `${transport}-ide:${sessionId}`;
    }

    private normalizeTeamAlias(alias: string): string {
        let normalized = alias.trim();
        const encoder = new TextEncoder();
        while (normalized && encoder.encode(normalized).length > 32) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    }

    /** Called by connection implementations whenever their physical state changes. */
    public async connectCallback(
        state: ConnectionState,
        connType: ConnectionType,
        source?: Connection,
    ): Promise<void> {
        if (connType === ConnectionType.USB) {
            const usbConnection = source instanceof USBConnection
                ? source
                : this.connections[ConnectionType.USB] as USBConnection;
            const record = this.ensureUSBSession(usbConnection);

            if (state === ConnectionState.Connected) {
                await this.initializeUSBSession(record);
            } else if (state === ConnectionState.Disconnected) {
                record.runtimeState = 'idle';
                record.state = 'disconnected';
                record.error = undefined;
                if (record.sessionId === this.activeUSBSessionId) {
                    record.connection.setIDEActive(false);
                    this.activeUSBSessionId = null;
                    this.activeConnection = null;
                    this.appMgr.emit(EventType.EVENT_CONNECTION_STATUS, ConnectionState.Disconnected.toString());
                    this.appMgr.emit(EventType.EVENT_FILESYS, '{}');
                }
                this.emitUSBFleet();
            }
            return;
        }

        const bluetooth = source instanceof BluetoothConnection
            ? source
            : this.connections[ConnectionType.BLUETOOTH] as BluetoothConnection;
        const record = this.ensureBLESession(bluetooth);
        if (state === ConnectionState.Connected) {
            const shouldResume = record.resumeActive && !this.activeConnection;
            if (!record.initialized || shouldResume || !this.activeConnection) {
                await this.initializeBLESession(record);
            } else {
                record.resumeActive = false;
                record.state = 'connected';
                record.error = undefined;
                record.connection.setIDEActive(false);
                this.emitBLEFleet();
            }
        } else if (state === ConnectionState.Disconnected) {
            const wasActive = record.sessionId === this.activeBLESessionId;
            record.runtimeState = 'idle';
            record.state = 'disconnected';
            record.resumeActive = wasActive;
            record.connection.setIDEActive(false);
            if (wasActive) {
                this.activeBLESessionId = null;
                this.activeConnection = null;
                this.appMgr.emit(EventType.EVENT_CONNECTION_STATUS, ConnectionState.Disconnected.toString());
                this.appMgr.emit(EventType.EVENT_FILESYS, '{}');
            }
            this.emitBLEFleet();
        }
    }

    private async initializeBLESession(record: BLERobotSessionRecord): Promise<void> {
        record.state = 'initializing';
        record.error = undefined;
        record.deviceName = record.connection.getDeviceName();
        record.browserDeviceId = record.connection.getBrowserDeviceId();
        this.activateBLERecord(record);
        this.emitBLEFleet();

        try {
            if (!(await record.connection.getToREPL())) {
                throw new Error('The XRP did not enter the Bluetooth MicroPython REPL. Reset it and try again.');
            }
            this.appMgr.emit(EventType.EVENT_CONNECTION_STATUS, ConnectionState.Connected.toString());
            await this.refreshFilesystemForRecord(record);
            await record.connection.getToNormal();
            await this.cmdToXRPMgr.clearIsRunning();
            this.xrpID = await this.cmdToXRPMgr.checkIfNeedUpdate();
            this.IDSet(ConnectionType.BLUETOOTH);
            await this.pluginMgr.pluginCheck();
            record.initialized = true;
            record.resumeActive = false;
            record.state = 'connected';
        } catch (error) {
            record.state = 'error';
            record.error = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            this.appMgr.emit(EventType.EVENT_HIDE_BLUETOOTH_CONNECTING, 'hide-bluetooth-connecting');
            this.emitBLEFleet();
        }
    }

    private activateBLERecord(record: BLERobotSessionRecord): void {
        const previous = this.getActiveRobotRecord();
        if (previous && previous.connection !== record.connection) {
            this.routeOutputToBuffer(previous);
        }
        for (const session of this.usbSessions.values()) session.connection.setIDEActive(false);
        for (const session of this.bleSessions.values()) {
            session.connection.setIDEActive(session.connection === record.connection);
        }
        this.activeConnection = record.connection;
        this.activeUSBSessionId = null;
        this.activeBLESessionId = record.sessionId;
        this.cmdToXRPMgr.setConnection(record.connection);
        this.broadcastActiveRuntimeState();
        this.emitUSBFleet();
    }

    private ensureBLESession(connection: BluetoothConnection): BLERobotSessionRecord {
        const existing = this.findBLESession(connection);
        if (existing) return existing;
        this.bleSessionSequence += 1;
        const deviceName = connection.getDeviceName();
        const record: BLERobotSessionRecord = {
            sessionId: `ble-xrp-${Date.now()}-${this.bleSessionSequence}`,
            alias: deviceName || `XRP Bluetooth ${this.bleSessionSequence}`,
            connection,
            state: 'connecting',
            initialized: false,
            resumeActive: false,
            runtimeState: 'idle',
            deviceName,
            browserDeviceId: connection.getBrowserDeviceId(),
            terminalBuffer: '',
            commands: this.createSessionCommandManager(connection),
            multiAgentLibraryInstalled: false,
        };
        this.bleSessions.set(record.sessionId, record);
        return record;
    }

    private findBLESession(connection: BluetoothConnection): BLERobotSessionRecord | undefined {
        return [...this.bleSessions.values()].find((record) => record.connection === connection);
    }

    private requireBLESession(sessionId: string): BLERobotSessionRecord {
        const record = this.bleSessions.get(sessionId);
        if (!record) throw new Error(`Unknown Bluetooth XRP session: ${sessionId}`);
        return record;
    }

    private emitBLEFleet(): void {
        this.appMgr.emit(EventType.EVENT_BLE_IDE_FLEET, JSON.stringify(this.getBLEFleetSnapshot()));
    }

    private async initializeUSBSession(record: USBRobotSessionRecord): Promise<void> {
        record.state = 'initializing';
        record.error = undefined;
        const portInfo = record.connection.getPortInfo();
        record.usbVendorId = portInfo?.usbVendorId;
        record.usbProductId = portInfo?.usbProductId;
        this.activateUSBRecord(record);
        this.emitUSBFleet();

        try {
            if (!(await record.connection.getToREPL())) {
                throw new Error('The XRP did not enter the MicroPython REPL. Reset it and try again.');
            }
            this.appMgr.emit(EventType.EVENT_CONNECTION_STATUS, ConnectionState.Connected.toString());
            await this.refreshFilesystemForRecord(record);
            await record.connection.getToNormal();
            await this.cmdToXRPMgr.resetTerminal();
            await this.cmdToXRPMgr.clearIsRunning();
            this.xrpID = await this.cmdToXRPMgr.checkIfNeedUpdate();
            this.IDSet(ConnectionType.USB);
            await this.pluginMgr.pluginCheck();
            record.initialized = true;
            record.state = 'connected';
        } catch (error) {
            record.state = 'error';
            record.error = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            this.emitUSBFleet();
        }
    }

    private activateUSBRecord(record: USBRobotSessionRecord): void {
        const previous = this.getActiveRobotRecord();
        if (previous && previous.connection !== record.connection) {
            this.routeOutputToBuffer(previous);
        }
        for (const session of this.usbSessions.values()) {
            session.connection.setIDEActive(session.connection === record.connection);
        }
        for (const session of this.bleSessions.values()) session.connection.setIDEActive(false);
        this.activeConnection = record.connection;
        this.activeUSBSessionId = record.sessionId;
        this.activeBLESessionId = null;
        this.connections[ConnectionType.USB] = record.connection;
        this.cmdToXRPMgr.setConnection(record.connection);
        this.broadcastActiveRuntimeState();
        this.emitBLEFleet();
    }

    private ensureUSBSession(connection: USBConnection): USBRobotSessionRecord {
        const existing = this.findUSBSession(connection);
        if (existing) return existing;

        this.usbSessionSequence += 1;
        const record: USBRobotSessionRecord = {
            sessionId: `usb-xrp-${Date.now()}-${this.usbSessionSequence}`,
            alias: `XRP USB ${this.usbSessionSequence}`,
            connection,
            state: 'connecting',
            initialized: false,
            runtimeState: 'idle',
            terminalBuffer: '',
            commands: this.createSessionCommandManager(connection),
            multiAgentLibraryInstalled: false,
        };
        this.usbSessions.set(record.sessionId, record);
        return record;
    }

    private findUSBSession(connection: USBConnection): USBRobotSessionRecord | undefined {
        return [...this.usbSessions.values()].find((record) => record.connection === connection);
    }

    private requireUSBSession(sessionId: string): USBRobotSessionRecord {
        const record = this.usbSessions.get(sessionId);
        if (!record) throw new Error(`Unknown USB XRP session: ${sessionId}`);
        return record;
    }

    private emitUSBFleet(): void {
        this.appMgr.emit(EventType.EVENT_USB_FLEET, JSON.stringify(this.getUSBFleetSnapshot()));
    }

    private getRobotRecord(sessionId: string): IDERobotSessionRecord | undefined {
        return this.usbSessions.get(sessionId) ?? this.bleSessions.get(sessionId);
    }

    private getActiveRobotRecord(): IDERobotSessionRecord | undefined {
        const activeUSB = this.activeUSBSessionId ? this.usbSessions.get(this.activeUSBSessionId) : undefined;
        if (activeUSB) return activeUSB;
        return this.activeBLESessionId ? this.bleSessions.get(this.activeBLESessionId) : undefined;
    }

    private appendTerminalBuffer(record: IDERobotSessionRecord, data: string): void {
        const maximumLength = 12000;
        record.terminalBuffer = (record.terminalBuffer + data).slice(-maximumLength);
    }

    private async refreshFilesystemForRecord(record: IDERobotSessionRecord): Promise<void> {
        const filesystemJson = await record.commands.getOnBoardFSTree(false);
        if (filesystemJson) {
            record.filesystemCache = filesystemJson;
            this.appMgr.emit(EventType.EVENT_FILESYS, filesystemJson);
        } else {
            this.emitCachedFilesystem(record);
        }
    }

    private emitCachedFilesystem(record: IDERobotSessionRecord): void {
        if (record.filesystemCache) {
            this.appMgr.emit(EventType.EVENT_FILESYS, record.filesystemCache);
        }
    }

    private routeOutputToBuffer(record: IDERobotSessionRecord): void {
        record.connection.onData = (data: string) => {
            this.appendTerminalBuffer(record, data);
        };
    }

    private setRobotRuntimeState(record: IDERobotSessionRecord, runtimeState: IDERobotRuntimeState): void {
        if (record.runtimeState === runtimeState) return;
        record.runtimeState = runtimeState;
        if (runtimeState === 'running') {
            record.lastRunStartedAt = Date.now();
            record.lastRunFinishedAt = undefined;
            record.terminalBuffer = '';
        } else {
            record.lastRunFinishedAt = Date.now();
        }
        this.emitUSBFleet();
        this.emitBLEFleet();
        if (record.sessionId === this.getActiveRobotSessionId()) {
            this.broadcastActiveRuntimeState();
        }
    }

    private broadcastActiveRuntimeState(): void {
        this.appMgr.emit(
            EventType.EVENT_ISRUNNING,
            this.getActiveRobotRuntimeState() === 'running' ? 'running' : 'stopped',
        );
    }

    private createSessionCommandManager(connection: Connection): CommandToXRPMgr {
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(connection);
        return commands;
    }

    IDSet = (connType: ConnectionType) => {
        if (this.xrpID != undefined) {
            const data = {
                XRPID: this.xrpID.slice(-5),
                platform: 'XRP-react',
                BLE: connType === ConnectionType.BLUETOOTH,
            };
            try {
                void fetch('https://xrpid-464879733234.us-central1.run.app/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                });
            } catch (err) {
                console.log(err);
            }
            this.appMgr.emit(EventType.EVENT_ID, JSON.stringify(data));
        }
    };

    public getConnection(): Connection | null {
        return this.activeConnection;
    }

    public stop(): void {
        void this.disconnectAllUSB();
        void this.disconnectAllBluetooth();
        const defaultBluetooth = this.connections[ConnectionType.BLUETOOTH] as BluetoothConnection;
        if (!this.findBLESession(defaultBluetooth) && defaultBluetooth.isConnected()) {
            void defaultBluetooth.disconnect();
        }
    }
}
