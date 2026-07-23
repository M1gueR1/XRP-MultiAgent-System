export type IDERobotRuntimeState = 'idle' | 'starting' | 'running' | 'stopping';

export interface IDERobotTargetSnapshot {
    sessionId: string;
    alias: string;
    transport: 'usb' | 'bluetooth';
}

export interface IDERobotRunPreflight {
    voltage: number;
    isNanoXRP: boolean;
    xrpDrive: string;
    transport: 'usb' | 'bluetooth';
}

export interface MultiRobotEditorRequest {
    fileType: 'python' | 'blockly';
    name: string;
    sessionIds: string[];
}

export interface MultiRobotSaveRequest {
    editorId: string;
    code: string;
}
