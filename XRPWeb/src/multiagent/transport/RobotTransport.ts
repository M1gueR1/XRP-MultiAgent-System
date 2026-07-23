export interface RobotTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  writeData(data: Uint8Array): Promise<void>;
  onData(listener: (data: Uint8Array) => void): () => void;
  onDisconnected(listener: () => void): () => void;
  dispose?(): void;
  readonly deviceName?: string;
  readonly browserIdentity?: string;
}
