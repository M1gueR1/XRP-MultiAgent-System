import type { USBConnection } from '@/connections/usbconnection';
import type { RobotTransport } from './RobotTransport';

/** Reuses an already-open Web Serial IDE connection without owning its lifecycle. */
export class USBIDETransport implements RobotTransport {
  private attached = false;

  constructor(private readonly connection: USBConnection) {}

  async connect(): Promise<void> {
    if (!this.connection.isConnected()) throw new Error('The USB IDE robot is disconnected.');
    if (!this.connection.hasRuntimeDataChannel()) {
      throw new Error('The XRP USB serial channel required for team messages is unavailable.');
    }
    this.attached = true;
  }

  async disconnect(): Promise<void> {
    this.attached = false;
  }

  isConnected(): boolean {
    return this.attached && this.connection.isConnected() && this.connection.hasRuntimeDataChannel();
  }

  async writeData(data: Uint8Array): Promise<void> {
    if (!this.isConnected()) throw new Error('The USB IDE team-message transport is not attached.');
    await this.connection.writeRuntimeData(data);
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    return this.connection.onRuntimeData(listener);
  }

  onDisconnected(listener: () => void): () => void {
    return this.connection.onRuntimeDisconnected(listener);
  }
}
