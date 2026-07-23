import ConnectionMgr from '@/managers/connectionmgr';
import { ConnectionType } from '@/utils/types';
import Connection, { ConnectionState } from '@connections/connection';
import TableMgr from '@/managers/tablemgr';
import AppMgr, { EventType } from '@/managers/appmgr';

/**
 * BluetoothConnection class
 * 
 * This class is responsible for establish a bluetooth connection with the XRP Robot
 */
export class BluetoothConnection extends Connection {
    //bluetooth information
    private bleDevice: BluetoothDevice | undefined;
    private btService: BluetoothRemoteGATTService | undefined;
    private bleReader: BluetoothRemoteGATTCharacteristic | undefined;
    private bleWriter: BluetoothRemoteGATTCharacteristic | undefined;
    private bleDataReader: BluetoothRemoteGATTCharacteristic | undefined;
    private bleDataWriter: BluetoothRemoteGATTCharacteristic | undefined;

    // UUIDs for standard NORDIC UART service and characteristics
    private readonly UART_SERVICE_UUID: string = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    private readonly TX_CHARACTERISTIC_UUID: string = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
    private readonly RX_CHARACTERISTIC_UUID: string = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
    private readonly DATA_TX_CHARACTERISTIC_UUID: string = '92ae6088-f24d-4360-b1b1-a432a8ed36ff';
    private readonly DATA_RX_CHARACTERISTIC_UUID: string = '92ae6088-f24d-4360-b1b1-a432a8ed36fe';

    // bluetooth data
    private bleData: Uint8Array | null = null;
    private bleDataResolveFunc: ((value: Uint8Array) => void) | null = null;
    private ble2Data: Uint8Array | null = null;
    private ble2DataResolveFunc: ((value: Uint8Array) => void) | null = null;

    private readonly BLE_STOP_MSG  = "##XRPSTOP##"
    private reconnectSuccess: boolean = true;
    private readWorkerRunning: boolean = false;
    private disconnectNotified: boolean = false;
    private manualDisconnect: boolean = false;
    private readonly autoReconnect: boolean;
    private notificationReader?: BluetoothRemoteGATTCharacteristic;
    private notificationDataReader?: BluetoothRemoteGATTCharacteristic;
    private disconnectListenerDevice?: BluetoothDevice;
    private suppressManagerCallback: boolean = false;
    private disconnectGeneration: number = 0;
    private readonly runtimeDataListeners = new Set<(data: Uint8Array) => void>();
    private readonly runtimeDisconnectedListeners = new Set<() => void>();
    private runtimeWriteQueue: Promise<void> = Promise.resolve();

    private  Table: TableMgr | undefined = undefined;

    constructor(connMgr: ConnectionMgr, options: { autoReconnect?: boolean } = {}) {
        super();
        this.connMgr = connMgr;
        this.autoReconnect = options.autoReconnect ?? true;
        if(this.joyStick)
            this.joyStick.writeToDevice = this.writeToDataDevice.bind(this);
        this.Table = new TableMgr();
    }

    /**
     * connectWithTimeout - try to reconnect with timeout
     * @param device
     * @param timeoutMs
     * @returns
     */
    private connectWithTimeout(
        device: BluetoothDevice,
        timeoutMs: number,
    ): Promise<BluetoothRemoteGATTServer> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Connection timed out'));
            }, timeoutMs);

            device
                .gatt!.connect()
                .then((server) => {
                    clearTimeout(timeoutId);
                    resolve(server);
                })
                .catch((err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                });
        });
    }

    /**
     * startBLEData
     */
    startBLEData() {
        // Set up the event listener for the RX characteristic
        if (this.bleReader && this.notificationReader !== this.bleReader) {
            this.notificationReader = this.bleReader;
            this.bleReader.addEventListener('characteristicvaluechanged', (event) => {
            const charEvent = event as Event & { target: BluetoothRemoteGATTCharacteristic };
            const value = charEvent.target.value;
            //if(this.DEBUG_CONSOLE_ON) this.connLogger.debug(this.TEXT_DECODER.decode(value));
            if (this.bleData == null) {
                this.bleData = new Uint8Array(value!.buffer); //just in case the resolve is not ready
            } else {
                this.bleData = this.concatUint8Arrays(
                    this.bleData,
                    new Uint8Array(value!.buffer),
                );
            }
            if (this.bleDataResolveFunc) {
                this.bleDataResolveFunc(this.bleData);
                this.bleDataResolveFunc = null;
                this.bleData = new Uint8Array(0);
            }
            //let str = arrayBufferToString(value.buffer); // Convert ArrayBuffer to string
            //resolve(new Uint8Array(value.buffer)); // Resolve the promise with the received string
            });
        }
        // Optional: Reject the promise on some condition, e.g., timeout or error

        if(this.bleDataReader != undefined && this.notificationDataReader !== this.bleDataReader){
            this.notificationDataReader = this.bleDataReader;
            this.bleDataReader.addEventListener('characteristicvaluechanged', (event) => {
                const charEvent = event as Event & { target: BluetoothRemoteGATTCharacteristic };
                const value = charEvent.target.value;
                if (!value) return;
                const runtimeData = new Uint8Array(
                    value.buffer,
                    value.byteOffset,
                    value.byteLength,
                ).slice();
                for (const listener of this.runtimeDataListeners) listener(runtimeData);
                //if(this.DEBUG_CONSOLE_ON) this.connLogger.debug(this.TEXT_DECODER.decode(value));
                if (this.ble2Data == null) {
                    this.ble2Data = new Uint8Array(value!.buffer); //just in case the resolve is not ready
                } else {
                    this.ble2Data = this.concatUint8Arrays(
                        this.ble2Data,
                        new Uint8Array(value!.buffer),
                    );
                }
                if (this.ble2DataResolveFunc) {
                    this.ble2DataResolveFunc(this.ble2Data);
                    this.ble2DataResolveFunc = null;
                    this.ble2Data = new Uint8Array(0);
                }
                //let str = arrayBufferToString(value.buffer); // Convert ArrayBuffer to string
                //resolve(new Uint8Array(value.buffer)); // Resolve the promise with the received string
            });
        }

    }

    /**
     * getBLEData - received BLE data from XRP Robot
     * @param timeout 
     * @returns 
     */
    async getBLEData(timeout = 10): Promise<Uint8Array | undefined> {
        return new Promise((resolve) => {
            if(this.bleData != null && this.bleData?.length > 0){
                const data = this.bleData;
                this.bleData = null;
                resolve(data);
            }
            const timeoutId = setTimeout(() => {
                this.bleDataResolveFunc = null; // Clear reference
                resolve(undefined);
            }, timeout);

            this.bleDataResolveFunc = (data) => {
                clearTimeout(timeoutId); // Prevent timeout from resolving
                resolve(data);
            };
        });
    }

    /**
     * get2BLEData - received BLE data from the bleDataReader from XRP Robot
     * @param timeout 
     * @returns 
     */
    async get2BLEData(timeout = 10): Promise<Uint8Array | undefined> {
        return new Promise((resolve) => {
            if(this.ble2Data != null && this.ble2Data?.length > 0){
                const data = this.ble2Data;
                this.ble2Data = null;
                resolve(data);
            }
            const timeoutId = setTimeout(() => {
                this.ble2DataResolveFunc = null; // Clear reference
                resolve(undefined);
            }, timeout);

            this.ble2DataResolveFunc = (data) => {
                clearTimeout(timeoutId); // Prevent timeout from resolving
                resolve(data);
            };
        });
    }



    /**
     * readWorker - this worker read data from the XRP robot
     */
    async readWorker() {
        this.readWorkerRunning = true;
        this.startBLEData();
        try {
            while (this.connectionStates === ConnectionState.Connected) {
                    let values: Uint8Array | undefined = undefined;
                    values = await this.getBLEData();
                    this.readData(values);
                
                    let valuesD: Uint8Array | undefined = undefined;
                    if(this.bleDataReader != undefined){
                        valuesD = await this.get2BLEData();
                        if(valuesD != undefined) {
                            // Extract complete XPP packets and only process those
                            // Note: regularData is ignored since bleDataReader only receives XPP packets
                            const { packets } = this.extractCompleteXPPPackets(valuesD);
                            for (const packet of packets) {
                                this.processXPPPacket(packet, this.Table);
                            }
                        }
                    }
                
            }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch(err: any) {
            throw new Error('read work exception: ' + err.message);
        } finally {
            this.readWorkerRunning = false;
        }
    }

    /**
     * onConnected
     */
    private async onConnected() {
        this.connectionStates = ConnectionState.Connected;
        this.disconnectNotified = false;
        this.manualDisconnect = false;
        this.lastProgramRan = undefined;
        if(!this.readWorkerRunning){  // if the read worker is not running then restart it  
            void this.readWorker();
        }
        else{
            this.startBLEData(); // the readers may have been updated so start them again
        }
        if (this.connMgr && !this.suppressManagerCallback) {
            await this.connMgr.connectCallback(this.connectionStates, ConnectionType.BLUETOOTH, this);
        }
        //await this.getToNormal();
    }

    /**
     * onDisconnected
     */
    private async onDisconnected() {
        if (this.disconnectNotified) return;
        this.disconnectNotified = true;
        this.connectionStates = ConnectionState.Disconnected;
        for (const listener of this.runtimeDisconnectedListeners) listener();
        if (this.connLogger && !this.suppressManagerCallback) {
            await this.connMgr?.connectCallback(this.connectionStates, ConnectionType.BLUETOOTH, this);
        }
    }

    private async handleGATTDisconnected(): Promise<void> {
        this.disconnectGeneration += 1;
        this.connectionStates = ConnectionState.Disconnected;
        await this.onDisconnected();
        if (this.autoReconnect && !this.manualDisconnect && this.bleDevice) {
            try {
                await this.reconnect();
            } catch (error) {
                this.connLogger.debug(`BLE automatic reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * isConnected - query connection status
     */
    isConnected(): boolean {
        return this.connectionStates === ConnectionState.Connected;
    }

    /**
     * connect - connecting BLE device
     * @returns
     */
    public async connect(): Promise<void> {
        if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser.');
        if (this.connectionStates === ConnectionState.Busy) return;

        this.connectionStates = ConnectionState.Busy;
        this.manualDisconnect = false;
        this.disconnectNotified = false;
        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'XRP' }],
                optionalServices: [this.UART_SERVICE_UUID],
            });
            if (this.connMgr?.isBluetoothDeviceClaimed(device, this)) {
                throw new Error('That XRP is already connected. Choose a different Bluetooth device.');
            }

            this.bleDevice = device;
            AppMgr.getInstance().emit(EventType.EVENT_SHOWBLUETOOTH_CONNECTING, 'show-bluetooth-connecting');
            if (device.gatt?.connected) device.gatt.disconnect();
            if (!device.gatt) throw new Error('The selected XRP does not expose a Bluetooth GATT server.');
            const server = await device.gatt.connect();
            await this.discoverCharacteristics(server);
            this.attachDisconnectListener(device);
            this.reconnectSuccess = true;
            await this.onConnected();
        } catch (error) {
            this.connectionStates = ConnectionState.Disconnected;
            this.manualDisconnect = true;
            if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
            AppMgr.getInstance().emit(EventType.EVENT_HIDE_BLUETOOTH_CONNECTING, 'hide-bluetooth-connecting');
            throw new Error(`BLE connection failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public async disconnect(): Promise<void> {
        this.manualDisconnect = true;
        this.connectionStates = ConnectionState.Disconnected;
        try { await this.bleReader?.stopNotifications(); } catch { /* already stopped */ }
        try { await this.bleDataReader?.stopNotifications(); } catch { /* optional characteristic */ }
        if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
        this.bleWriter = undefined;
        this.bleReader = undefined;
        this.bleDataWriter = undefined;
        this.bleDataReader = undefined;
        await this.onDisconnected();
    }

    public async reconnect(): Promise<void> {
        if (!this.bleDevice?.gatt) {
            await this.connect();
            return;
        }
        if (this.isConnected()) return;
        this.manualDisconnect = false;
        this.disconnectNotified = false;
        this.connectionStates = ConnectionState.Busy;
        try {
            const server = await this.connectWithTimeout(this.bleDevice, 10000);
            await this.discoverCharacteristics(server);
            this.reconnectSuccess = true;
            await this.onConnected();
        } catch (error) {
            this.connectionStates = ConnectionState.Disconnected;
            await this.onDisconnected();
            throw error;
        }
    }

    private async discoverCharacteristics(server: BluetoothRemoteGATTServer): Promise<void> {
        this.btService = await server.getPrimaryService(this.UART_SERVICE_UUID);
        this.bleWriter = await this.btService.getCharacteristic(this.TX_CHARACTERISTIC_UUID);
        this.bleReader = await this.btService.getCharacteristic(this.RX_CHARACTERISTIC_UUID);
        this.bleDataWriter = undefined;
        this.bleDataReader = undefined;
        try {
            this.bleDataWriter = await this.btService.getCharacteristic(this.DATA_TX_CHARACTERISTIC_UUID);
            this.bleDataReader = await this.btService.getCharacteristic(this.DATA_RX_CHARACTERISTIC_UUID);
        } catch {
            this.connLogger.info('Optional XRP DATA characteristics are not available; IDE UART remains enabled.');
        }
        await this.bleReader.startNotifications();
        if (this.bleDataReader) await this.bleDataReader.startNotifications();
    }

    private attachDisconnectListener(device: BluetoothDevice): void {
        if (this.disconnectListenerDevice === device) return;
        this.disconnectListenerDevice = device;
        device.addEventListener('gattserverdisconnected', () => {
            void this.handleGATTDisconnected();
        });
    }

    public getDevice(): BluetoothDevice | undefined {
        return this.bleDevice;
    }

    public getDeviceName(): string | undefined {
        return this.bleDevice?.name;
    }

    public getBrowserDeviceId(): string | undefined {
        return this.bleDevice?.id;
    }

    public hasRuntimeDataChannel(): boolean {
        return this.bleDataReader !== undefined && this.bleDataWriter !== undefined;
    }

    public onRuntimeData(listener: (data: Uint8Array) => void): () => void {
        this.runtimeDataListeners.add(listener);
        return () => this.runtimeDataListeners.delete(listener);
    }

    public onRuntimeDisconnected(listener: () => void): () => void {
        this.runtimeDisconnectedListeners.add(listener);
        return () => this.runtimeDisconnectedListeners.delete(listener);
    }

    public async writeRuntimeData(data: Uint8Array): Promise<void> {
        if (!this.isConnected() || !this.bleDataWriter) {
            throw new Error('The XRP Bluetooth DATA channel is not connected.');
        }
        this.runtimeWriteQueue = this.runtimeWriteQueue.then(async () => {
            if (!this.bleDataWriter) throw new Error('The XRP Bluetooth DATA writer is unavailable.');
            if (
                this.bleDataWriter.properties.writeWithoutResponse &&
                typeof this.bleDataWriter.writeValueWithoutResponse === 'function'
            ) {
                await this.bleDataWriter.writeValueWithoutResponse(data as BufferSource);
            } else {
                await this.bleDataWriter.writeValue(data as BufferSource);
            }
        });
        await this.runtimeWriteQueue;
    }

    private str2ab(str: string): ArrayBuffer {
        const buf = new ArrayBuffer(str.length);
        const bufView = new Uint8Array(buf);
        for (let i = 0, strLen = str.length; i < strLen; i++) bufView[i] = str.charCodeAt(i);
        return buf;
    }

    /**
     * writeToDevice
     * @param str 
     */
    public async writeToDevice(str: string | Uint8Array) {
        this.connLogger.debug('writeToDevice BLE: ' + str);

        try {
            if (typeof str == 'string') {
                //this.connLogger.debug("writing: " + str);
                await this.bleQueue(this.str2ab(str));
            } else {
                //this.connLogger.debug("writing: " + this.TEXT_DECODER.decode(str));
                await this.bleQueue(str as BufferSource);
            }
        } catch (error) {
            this.connLogger.debug(error);
        }
    }

     /**
     * writeToDataDevice
     * @param Uint8Array 
     */
     public async writeToDataDevice(data: Uint8Array) {
        this.connLogger.debug('writeToDataDevice BLE: ' + data);

        try {
            await this.writeRuntimeData(data);
        } catch (error) {
            this.connLogger.debug(error);
        }

        return Promise.resolve(); // Indicate success
    }

    /**
     *  bleQueue - If we haven't come back from the ble.writeValue then the GATT is still busy and we will miss items that are being sent
     * This can be seen if you type very fast in the Shell 
     */
    private Queue:Promise<void> = Promise.resolve();
    private async  bleQueue(value: BufferSource){
        this.Queue = this.Queue.then(async () => {
            try {
                await this.bleWriter?.writeValue(value);
            } catch (error) {
                console.error('ble write failed:', error);
            }
        });
        await this.Queue;
    }

    public async getToREPL():Promise<boolean>{
        this.connLogger.info("BLE getToREPL")
        if(await this.checkPrompt()){
            //this.connLogger.info("BLE getToREPL: checkPrompt succeeded");
            return true;
        }

        if(!this.reconnectSuccess){
            //this.connLogger.info("BLE getToREPL: leaving nothing done");
            return false;
        }
        // Need to send BLE_STOP_MSG, this causes the XRP to reboot so we need to wait for reconnect to complete
        this.reconnectSuccess = false;
        this.suppressManagerCallback = true;
        const startingDisconnectGeneration = this.disconnectGeneration;
        try {
            await this.writeToDevice(this.BLE_STOP_MSG);
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                if (this.disconnectGeneration > startingDisconnectGeneration &&
                    this.connectionStates === ConnectionState.Connected) {
                    return true;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
        } finally {
            this.suppressManagerCallback = false;
        }
    }
}
