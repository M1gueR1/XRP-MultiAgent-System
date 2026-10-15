import type { IDERobotRuntimeState } from './ideRobotTypes';

export type BLERobotSessionState =
    | 'connecting'
    | 'reconnecting'
    | 'initializing'
    | 'connected'
    | 'disconnected'
    | 'error';

export interface BLERobotSessionSnapshot {
    sessionId: string;
    alias: string;
    state: BLERobotSessionState;
    runtimeState: IDERobotRuntimeState;
    active: boolean;
    deviceName?: string;
    browserDeviceId?: string;
    bluetoothContextPreloaded: boolean;
    programFiles: string[];
    lastRunStartedAt?: number;
    lastRunFinishedAt?: number;
    error?: string;
}

export interface BLERobotFleetSnapshot {
    supported: boolean;
    activeSessionId: string | null;
    sessions: BLERobotSessionSnapshot[];
}
