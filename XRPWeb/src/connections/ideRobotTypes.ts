export interface IDERobotTargetSnapshot {
    sessionId: string;
    alias: string;
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
