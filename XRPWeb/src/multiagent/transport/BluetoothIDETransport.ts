import type { BluetoothConnection } from '@/connections/bluetoothconnection';
import type { RobotTransport } from './RobotTransport';

/** Reuses an already-open IDE GATT connection without owning its lifecycle. */
export class BluetoothIDETransport implements RobotTransport {
  private attached = false;

  constructor(private readonly connection: BluetoothConnection) {}

  get deviceName(): string | undefined {
    return this.connection.getDeviceName();
  }

  get browserIdentity(): string | undefined {
    return this.connection.getBrowserDeviceId();
  }

  async connect(): Promise<void> {
    if (!this.connection.isConnected()) throw new Error('The Bluetooth IDE robot is disconnected.');
    if (!this.connection.hasRuntimeDataChannel()) {
      throw new Error('This XRP firmware does not expose the Bluetooth DATA channel required for team messages.');
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
    if (!this.isConnected()) throw new Error('The Bluetooth IDE team-message transport is not attached.');
    await this.connection.writeRuntimeData(data);
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    return this.connection.onRuntimeData(listener);
  }

  onDisconnected(listener: () => void): () => void {
    return this.connection.onRuntimeDisconnected(listener);
  }
}
