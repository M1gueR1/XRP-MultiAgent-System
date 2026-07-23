import type { IDERobotRuntimeState } from './ideRobotTypes';

export type USBRobotSessionState =
    | 'connecting'
    | 'initializing'
    | 'connected'
    | 'disconnected'
    | 'error';

export interface USBRobotSessionSnapshot {
    sessionId: string;
    alias: string;
    state: USBRobotSessionState;
    runtimeState: IDERobotRuntimeState;
    active: boolean;
    usbVendorId?: number;
    usbProductId?: number;
    lastRunStartedAt?: number;
    lastRunFinishedAt?: number;
    error?: string;
}

export interface USBRobotFleetSnapshot {
    supported: boolean;
    activeSessionId: string | null;
    sessions: USBRobotSessionSnapshot[];
}
