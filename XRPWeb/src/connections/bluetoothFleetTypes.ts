export type BLERobotSessionState =
    | 'connecting'
    | 'initializing'
    | 'connected'
    | 'disconnected'
    | 'error';

export interface BLERobotSessionSnapshot {
    sessionId: string;
    alias: string;
    state: BLERobotSessionState;
    runtimeState: 'idle' | 'running';
    active: boolean;
    deviceName?: string;
    browserDeviceId?: string;
    lastRunStartedAt?: number;
    lastRunFinishedAt?: number;
    error?: string;
}

export interface BLERobotFleetSnapshot {
    supported: boolean;
    activeSessionId: string | null;
    sessions: BLERobotSessionSnapshot[];
}
