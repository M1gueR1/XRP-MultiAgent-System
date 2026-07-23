import type { RobotTransport } from "./RobotTransport";

const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const DATA_WRITER_UUID = "92ae6088-f24d-4360-b1b1-a432a8ed36ff";
const DATA_READER_UUID = "92ae6088-f24d-4360-b1b1-a432a8ed36fe";

export class WebBluetoothRuntimeTransport implements RobotTransport {
  private server?: BluetoothRemoteGATTServer;
  private writer?: BluetoothRemoteGATTCharacteristic;
  private reader?: BluetoothRemoteGATTCharacteristic;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly disconnectedListeners = new Set<() => void>();
  private listenedReader?: BluetoothRemoteGATTCharacteristic;
  private deviceDisconnectListening = false;

  private constructor(private readonly device: BluetoothDevice) {}

  static async requestFromUser(): Promise<WebBluetoothRuntimeTransport> {
    if (!("bluetooth" in navigator)) throw new Error("Web Bluetooth is not available in this browser.");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "XRP" }],
      optionalServices: [UART_SERVICE_UUID],
    });
    return new WebBluetoothRuntimeTransport(device);
  }

  get deviceName(): string | undefined {
    return this.device.name;
  }

  get browserIdentity(): string {
    return this.device.id;
  }

  async connect(): Promise<void> {
    if (!this.device.gatt) throw new Error("Selected Bluetooth device has no GATT server.");
    this.server = this.device.gatt.connected
      ? this.device.gatt
      : await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(UART_SERVICE_UUID);
    this.writer = await service.getCharacteristic(DATA_WRITER_UUID);
    this.reader = await service.getCharacteristic(DATA_READER_UUID);
    if (this.listenedReader !== this.reader) {
      this.listenedReader?.removeEventListener("characteristicvaluechanged", this.handleValueChanged);
      this.reader.addEventListener("characteristicvaluechanged", this.handleValueChanged);
      this.listenedReader = this.reader;
    }
    if (!this.deviceDisconnectListening) {
      this.device.addEventListener("gattserverdisconnected", this.handleDisconnected);
      this.deviceDisconnectListening = true;
    }
    await this.reader.startNotifications();
  }

  async disconnect(): Promise<void> {
    if (this.reader) {
      try { await this.reader.stopNotifications(); } catch { /* already stopped */ }
    }
    this.device.gatt?.disconnect();
    this.writer = undefined;
    this.reader = undefined;
  }

  isConnected(): boolean {
    return this.device.gatt?.connected === true && this.writer !== undefined;
  }

  async writeData(data: Uint8Array): Promise<void> {
    if (!this.writer || !this.isConnected()) throw new Error("Fleet BLE DATA writer is not connected.");
    if (
      this.writer.properties.writeWithoutResponse &&
      typeof this.writer.writeValueWithoutResponse === "function"
    ) {
      await this.writer.writeValueWithoutResponse(data);
      return;
    }
    await this.writer.writeValue(data);
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.add(listener);
    return () => this.disconnectedListeners.delete(listener);
  }

  dispose(): void {
    this.listenedReader?.removeEventListener("characteristicvaluechanged", this.handleValueChanged);
    if (this.deviceDisconnectListening) {
      this.device.removeEventListener("gattserverdisconnected", this.handleDisconnected);
    }
    this.listenedReader = undefined;
    this.deviceDisconnectListening = false;
    this.dataListeners.clear();
    this.disconnectedListeners.clear();
  }

  private readonly handleValueChanged = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const value = characteristic.value;
    if (!value) return;
    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    for (const listener of this.dataListeners) listener(data);
  };

  private readonly handleDisconnected = (): void => {
    this.writer = undefined;
    this.reader = undefined;
    for (const listener of this.disconnectedListeners) listener();
  };
}
