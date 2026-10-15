export type RuntimeDataChannel = "ble-data" | "ble-uart" | "usb" | "unknown";

/** Browser-side timings; write completion is not proof of robot receipt. */
export interface TransportWriteDiagnostics {
  channel: RuntimeDataChannel;
  encodedBytes?: number;
  chunks?: number;
  attempts?: number;
  retries?: number;
  gattQueueMs?: number;
  gattOperationMs?: number;
  writeMode?: "with-response" | "without-response" | "legacy";
  chunkSizeBytes?: number;
}

export interface RobotTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  writeData(data: Uint8Array, diagnostics?: TransportWriteDiagnostics): Promise<void>;
  onData(listener: (data: Uint8Array) => void): () => void;
  onDisconnected(listener: () => void): () => void;
  dispose?(): void;
  readonly deviceName?: string;
  readonly browserIdentity?: string;
  readonly runtimeChannel?: RuntimeDataChannel;
  readonly supportsRuntimeUartWithoutResponse?: boolean;
  useRuntimeUartWithoutResponse?(chunkSizeBytes?: 20 | 55): () => void;
}
