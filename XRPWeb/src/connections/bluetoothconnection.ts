import type ConnectionMgr from '@/managers/connectionmgr';
import { ConnectionType } from '@/utils/types';
import Connection, { ConnectionState } from '@connections/connection';
import TableMgr from '@/managers/tablemgr';
import AppMgr, { EventType } from '@/managers/appmgr';
import { encodeUSBTeamFrame, USBTeamFrameParser } from '@/multiagent/transport/USBSerialTeamFraming';
import type { TransportWriteDiagnostics } from '@/multiagent/transport/RobotTransport';

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
    private gattWriteQueue: Promise<void> = Promise.resolve();
    private gattRecoveryPromise: Promise<void> | null = null;
    private recoveringGatt: boolean = false;
    private readonly runtimeUARTFrameParser = new USBTeamFrameParser();
    private readonly maximumWriteAttempts = 3;
    private readonly notificationStabilizationMs = 300;
    // Twenty bytes works with the default BLE ATT MTU used by both XRP
    // firmware generations. MultiAgentLib's stream parser reassembles frames.
    private readonly runtimeWriteChunkSize = 20;
    private runtimeUartWithoutResponseRequests = 0;
    private runtimeUart55Requests = 0;
    private runtimeUart55Profile?: { generation: number; writer: BluetoothRemoteGATTCharacteristic };

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
                    if (values) {
                        this.processRuntimeUARTData(values);
                    }
                
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
    private markPhysicalConnectionReady(): void {
        this.connectionStates = ConnectionState.Connected;
        this.disconnectNotified = false;
        this.manualDisconnect = false;
        this.lastProgramRan = undefined;
        if(!this.readWorkerRunning){  // if the read worker is not running then restart it  
            void this.readWorker();
        }
        else{
            this.startBLEData(); // the readers may have been updated so start them again
            // The previous worker may still be leaving its disconnected loop.
            // Give it a chance to finish, then restart it with the new readers.
            setTimeout(() => {
                if (this.connectionStates === ConnectionState.Connected && !this.readWorkerRunning) {
                    void this.readWorker();
                }
            }, 25);
        }
    }

    private async onConnected() {
        this.markPhysicalConnectionReady();
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
        if (this.bleDevice?.gatt?.connected) {
            if (this.suppressManagerCallback) this.disconnectGeneration += 1;
            return;
        }
        this.disconnectGeneration += 1;
        this.connectionStates = ConnectionState.Disconnected;
        this.invalidateGATTCharacteristics();
        const shouldRecover = this.autoReconnect && !this.manualDisconnect && Boolean(this.bleDevice);
        this.recoveringGatt = shouldRecover;
        await this.onDisconnected();
        if (shouldRecover) {
            try {
                await this.recoverGATTConnection();
            } catch (error) {
                this.recoveringGatt = false;
                this.connectionStates = ConnectionState.Disconnected;
                this.disconnectNotified = false;
                await this.onDisconnected();
                this.connLogger.debug(`BLE automatic reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            this.recoveringGatt = false;
            try {
                await this.onConnected();
            } catch (error) {
                // The physical link recovered. ConnectionMgr already records the
                // exact IDE initialization phase and keeps Reconnect available.
                this.connLogger.debug(
                    `BLE IDE initialization after reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    /**
     * isConnected - query connection status
     */
    isConnected(): boolean {
        return this.connectionStates === ConnectionState.Connected;
    }

    public isRecovering(): boolean {
        return this.recoveringGatt;
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
        let gattReady = false;
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
            if (this.manualDisconnect) {
                server.disconnect();
                throw new Error('Bluetooth connection was cancelled.');
            }
            await this.discoverCharacteristics(server);
            if (this.manualDisconnect || !device.gatt.connected) {
                throw new Error('The XRP disconnected during Bluetooth service discovery.');
            }
            this.attachDisconnectListener(device);
            gattReady = true;
            this.reconnectSuccess = true;
            await this.onConnected();
        } catch (error) {
            let connectionError = error;
            if (
                gattReady &&
                this.autoReconnect &&
                !this.manualDisconnect &&
                this.isTransientWriteError(error)
            ) {
                try {
                    await this.recoverGATTConnection(true);
                    await this.onConnected();
                    AppMgr.getInstance().emit(
                        EventType.EVENT_HIDE_BLUETOOTH_CONNECTING,
                        'hide-bluetooth-connecting',
                    );
                    return;
                } catch (recoveryError) {
                    connectionError = recoveryError;
                }
            }

            const keepPhysicalConnection =
                gattReady &&
                this.bleDevice?.gatt?.connected === true &&
                this.bleWriter !== undefined &&
                this.bleReader !== undefined;
            if (keepPhysicalConnection) {
                this.connectionStates = ConnectionState.Connected;
                this.manualDisconnect = false;
                AppMgr.getInstance().emit(
                    EventType.EVENT_HIDE_BLUETOOTH_CONNECTING,
                    'hide-bluetooth-connecting',
                );
                throw new Error(
                    `BLE IDE initialization failed: ${connectionError instanceof Error ? connectionError.message : String(connectionError)}. ` +
                    'Bluetooth GATT is connected, but the IDE is not ready; use Reconnect on this XRP to retry initialization.',
                );
            }
            this.connectionStates = ConnectionState.Disconnected;
            this.manualDisconnect = true;
            if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
            AppMgr.getInstance().emit(EventType.EVENT_HIDE_BLUETOOTH_CONNECTING, 'hide-bluetooth-connecting');
            throw new Error(`BLE connection failed: ${connectionError instanceof Error ? connectionError.message : String(connectionError)}`);
        }
    }

    public async disconnect(): Promise<void> {
        this.manualDisconnect = true;
        this.connectionStates = ConnectionState.Disconnected;
        if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
        const stopNotifications = Promise.allSettled([
            Promise.resolve().then(() => this.bleReader?.stopNotifications()),
            Promise.resolve().then(() => this.bleDataReader?.stopNotifications()),
        ]);
        let stopTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                stopNotifications,
                new Promise<void>((resolve) => {
                    stopTimeout = setTimeout(resolve, 1500);
                }),
            ]);
        } finally {
            if (stopTimeout) clearTimeout(stopTimeout);
        }
        this.invalidateGATTCharacteristics();
        await this.onDisconnected();
    }

    public async reconnectWithDeviceChooser(): Promise<void> {
        if (!navigator.bluetooth || !this.bleDevice) {
            throw new Error('The Bluetooth XRP is no longer available.');
        }
        const selected = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'XRP' }],
            optionalServices: [this.UART_SERVICE_UUID],
        });
        if (selected.id !== this.bleDevice.id) {
            throw new Error('Select the same XRP that was repaired over USB.');
        }
        this.bleDevice = selected;
        await this.reconnect(true);
    }

    public async reconnect(forceRediscovery: boolean = false): Promise<void> {
        if (!this.bleDevice?.gatt) {
            await this.connect();
            return;
        }
        if (!forceRediscovery && this.isConnected() && this.bleDevice.gatt.connected && this.bleWriter && this.bleReader) return;
        this.manualDisconnect = false;
        this.disconnectNotified = false;
        let physicalConnectionReady = false;
        try {
            await this.recoverGATTConnection(forceRediscovery);
            physicalConnectionReady = true;
            await this.onConnected();
        } catch (error) {
            if (
                physicalConnectionReady &&
                this.bleDevice.gatt.connected &&
                this.bleWriter &&
                this.bleReader
            ) {
                this.connectionStates = ConnectionState.Connected;
                throw error;
            }
            this.connectionStates = ConnectionState.Disconnected;
            await this.onDisconnected();
            throw error;
        }
    }

    private async recoverGATTConnection(forceRediscovery: boolean = false): Promise<void> {
        if (this.manualDisconnect) {
            throw new Error('Bluetooth reconnection was cancelled because the XRP was disconnected manually.');
        }
        if (this.gattRecoveryPromise) {
            await this.gattRecoveryPromise;
            if (this.bleDevice?.gatt?.connected && this.bleWriter && this.bleReader) return;
        }
        if (
            !forceRediscovery &&
            this.connectionStates === ConnectionState.Connected &&
            this.bleDevice?.gatt?.connected &&
            this.bleWriter &&
            this.bleReader
        ) {
            return;
        }
        if (!this.bleDevice?.gatt) {
            throw new Error('The selected XRP does not expose a Bluetooth GATT server.');
        }

        const recovery = (async () => {
            this.connectionStates = ConnectionState.Busy;
            this.invalidateGATTCharacteristics();
            let lastError: unknown;
            for (let attempt = 1; attempt <= this.maximumWriteAttempts; attempt += 1) {
                if (this.manualDisconnect) throw new Error('Bluetooth reconnection was cancelled.');
                try {
                    const server = this.bleDevice!.gatt!.connected
                        ? this.bleDevice!.gatt!
                        : await this.connectWithTimeout(this.bleDevice!, 10000);
                    await this.discoverCharacteristics(server);
                    if (!server.connected || this.manualDisconnect) {
                        throw new Error('The XRP disconnected during Bluetooth service discovery.');
                    }
                    this.reconnectSuccess = true;
                    this.markPhysicalConnectionReady();
                    return;
                } catch (error) {
                    lastError = error;
                    this.invalidateGATTCharacteristics();
                    this.connLogger.debug(`BLE GATT recovery attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
                    if (attempt < this.maximumWriteAttempts && !this.manualDisconnect) {
                        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
                    }
                }
            }
            this.connectionStates = ConnectionState.Disconnected;
            throw lastError;
        })();
        this.gattRecoveryPromise = recovery;
        try {
            await recovery;
        } finally {
            if (this.gattRecoveryPromise === recovery) this.gattRecoveryPromise = null;
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
        await new Promise((resolve) => setTimeout(resolve, this.notificationStabilizationMs));
    }

    private invalidateGATTCharacteristics(): void {
        this.btService = undefined;
        this.bleWriter = undefined;
        this.bleReader = undefined;
        this.bleDataWriter = undefined;
        this.bleDataReader = undefined;
        this.bleData = null;
        this.ble2Data = null;
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
        return this.isConnected() && this.bleWriter !== undefined;
    }

    public hasDedicatedRuntimeDataChannel(): boolean {
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

    private processRuntimeUARTData(values: Uint8Array): void {
        const runtimeFrames = this.runtimeUARTFrameParser.push(values);
        for (const packet of runtimeFrames.packets) {
            for (const listener of this.runtimeDataListeners) listener(packet);
        }
        if (runtimeFrames.regularData.length > 0) {
            this.readData(runtimeFrames.regularData);
        }
    }

    public supportsRuntimeUartWithoutResponse(): boolean {
        return !this.bleDataWriter && this.bleWriter?.properties?.writeWithoutResponse === true &&
            typeof this.bleWriter.writeValueWithoutResponse === 'function';
    }

    public useRuntimeUartWithoutResponse(chunkSizeBytes: 20 | 55 = 20): () => void {
        if (chunkSizeBytes !== 20 && chunkSizeBytes !== 55) {
            throw new RangeError('UART experiment chunk size must be 20 or 55 bytes.');
        }
        if (!this.supportsRuntimeUartWithoutResponse()) {
            throw new Error('This XRP does not advertise UART writes without response. Prepare its BLE library over USB and reconnect.');
        }
        if (chunkSizeBytes === 55) {
            if (!this.isConnected()) throw new Error('Connect the XRP before selecting 55-byte UART writes.');
            if (this.runtimeUart55Profile) this.requireUart55Profile(this.runtimeUart55Profile);
            else this.runtimeUart55Profile = { generation: this.disconnectGeneration, writer: this.bleWriter! };
            this.runtimeUart55Requests += 1;
        }
        this.runtimeUartWithoutResponseRequests += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.runtimeUartWithoutResponseRequests -= 1;
            if (chunkSizeBytes === 55 && --this.runtimeUart55Requests === 0) this.runtimeUart55Profile = undefined;
        };
    }

    private requireUart55Profile(profile: { generation: number; writer: BluetoothRemoteGATTCharacteristic }): void {
        if (profile.generation !== this.disconnectGeneration || profile.writer !== this.bleWriter) {
            throw new Error('Bluetooth changed during the 55-byte experiment. Recheck the XRP MTU and RX buffer before a new test.');
        }
    }

    public async writeRuntimeData(data: Uint8Array, diagnostics?: TransportWriteDiagnostics): Promise<void> {
        const uartWithoutResponse = this.runtimeUartWithoutResponseRequests > 0;
        const uart55Profile = this.runtimeUart55Requests > 0 ? this.runtimeUart55Profile : undefined;
        await this.ensureREPLChannel();
        if (!this.hasRuntimeDataChannel()) {
            throw new Error('The XRP Bluetooth runtime channel is not connected.');
        }
        if (!this.bleDataWriter) {
            // Older XRP firmware has only the BLE UART characteristics. During
            // a running program that UART behaves like stdin/stdout, so reuse
            // the same ASCII-safe framing proven by the USB transport.
            const framed = encodeUSBTeamFrame(data);
            // Larger frames retain the existing conservative chunking policy.
            const uartChunkSize = uart55Profile && framed.length <= 55 ? 55 : this.runtimeWriteChunkSize;
            if (diagnostics) Object.assign(diagnostics, {
                channel: 'ble-uart', encodedBytes: framed.length, chunks: 1, attempts: 0, retries: 0,
                writeMode: uartWithoutResponse ? 'without-response' :
                    typeof this.bleWriter?.writeValueWithResponse === 'function' ? 'with-response' : 'legacy',
                chunkSizeBytes: uartWithoutResponse ? uartChunkSize : framed.length,
            });
            if (uartWithoutResponse) {
                if (!this.supportsRuntimeUartWithoutResponse()) {
                    throw new Error('UART writes without response are no longer available on this XRP.');
                }
                if (diagnostics) diagnostics.chunks = 0;
                await this.enqueueGattWrite(async () => {
                    if (uart55Profile) this.requireUart55Profile(uart55Profile);
                    for (let offset = 0; offset < framed.length; offset += uartChunkSize) {
                        const chunk = framed.slice(offset, offset + uartChunkSize);
                        if (diagnostics) diagnostics.chunks = (diagnostics.chunks ?? 0) + 1;
                        await this.writeWithRetry(async () => {
                            if (uart55Profile) this.requireUart55Profile(uart55Profile);
                            if (!this.supportsRuntimeUartWithoutResponse()) {
                                throw new Error('UART writes without response are unavailable after Bluetooth recovery.');
                            }
                            await this.bleWriter!.writeValueWithoutResponse(chunk as BufferSource);
                        }, 'Bluetooth UART runtime', diagnostics);
                    }
                }, diagnostics);
                return;
            }
            await this.bleQueue(framed, diagnostics);
            return;
        }
        if (diagnostics) Object.assign(diagnostics, {
            channel: 'ble-data', encodedBytes: data.length, chunks: 0, attempts: 0, retries: 0,
            chunkSizeBytes: this.runtimeWriteChunkSize,
        });
        await this.enqueueGattWrite(async () => {
            if (!this.bleDataWriter) throw new Error('The XRP Bluetooth DATA writer is unavailable.');
            for (let offset = 0; offset < data.length; offset += this.runtimeWriteChunkSize) {
                const chunk = data.slice(offset, offset + this.runtimeWriteChunkSize);
                if (diagnostics) diagnostics.chunks = (diagnostics.chunks ?? 0) + 1;
                await this.writeWithRetry(async () => {
                    if (!this.bleDataWriter) {
                        throw new Error('The XRP Bluetooth DATA writer is unavailable.');
                    }
                    if (
                        this.bleDataWriter.properties.writeWithoutResponse &&
                        typeof this.bleDataWriter.writeValueWithoutResponse === 'function'
                    ) {
                        if (diagnostics) diagnostics.writeMode = 'without-response';
                        await this.bleDataWriter.writeValueWithoutResponse(chunk as BufferSource);
                    } else {
                        if (diagnostics) diagnostics.writeMode = 'legacy';
                        await this.bleDataWriter.writeValue(chunk as BufferSource);
                    }
                }, 'Bluetooth DATA', diagnostics);
            }
        }, diagnostics);
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
        await this.ensureREPLChannel();
        if (typeof str == 'string') {
            await this.bleQueue(this.str2ab(str));
        } else {
            await this.bleQueue(str as BufferSource);
        }
    }

    private async ensureREPLChannel(): Promise<void> {
        if (this.gattRecoveryPromise) await this.gattRecoveryPromise;
        if (this.isConnected() && this.bleWriter && this.bleDevice?.gatt?.connected !== false) return;
        if (this.autoReconnect && !this.manualDisconnect && this.bleDevice) {
            await this.recoverGATTConnection();
        }
        if (!this.isConnected() || !this.bleWriter || this.bleDevice?.gatt?.connected === false) {
            throw new Error('The XRP Bluetooth REPL channel is not connected.');
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
    private async bleQueue(value: BufferSource, diagnostics?: TransportWriteDiagnostics) {
        await this.enqueueGattWrite(async () => {
            if (!this.bleWriter) {
                throw new Error('The XRP Bluetooth REPL writer is unavailable.');
            }
            await this.writeWithRetry(
                () => typeof this.bleWriter!.writeValueWithResponse === 'function'
                    ? this.bleWriter!.writeValueWithResponse(value)
                    : this.bleWriter!.writeValue(value),
                'Bluetooth REPL',
                diagnostics,
            );
        }, diagnostics);
    }

    private async enqueueGattWrite(operation: () => Promise<void>, diagnostics?: TransportWriteDiagnostics): Promise<void> {
        const enqueuedAt = diagnostics ? performance.now() : 0;
        const write = this.gattWriteQueue.catch(() => undefined).then(async () => {
            const startedAt = diagnostics ? performance.now() : 0;
            if (diagnostics) diagnostics.gattQueueMs = startedAt - enqueuedAt;
            try {
                await operation();
            } finally {
                if (diagnostics) diagnostics.gattOperationMs = performance.now() - startedAt;
            }
        });
        this.gattWriteQueue = write.catch(() => undefined);
        await write;
    }

    private async writeWithRetry(
        operation: () => Promise<void>,
        channel: string,
        diagnostics?: TransportWriteDiagnostics,
    ): Promise<void> {
        let lastError: unknown;
        let attempted = 0;
        for (let attempt = 1; attempt <= this.maximumWriteAttempts; attempt += 1) {
            attempted = attempt;
            if (diagnostics) {
                diagnostics.attempts = (diagnostics.attempts ?? 0) + 1;
                if (attempt > 1) diagnostics.retries = (diagnostics.retries ?? 0) + 1;
            }
            try {
                await operation();
                return;
            } catch (error) {
                lastError = error;
                if (
                    this.isDisconnectedGATTError(error) &&
                    this.autoReconnect &&
                    !this.manualDisconnect &&
                    this.bleDevice
                ) {
                    try {
                        await this.recoverGATTConnection(true);
                    } catch (recoveryError) {
                        lastError = recoveryError;
                    }
                }
                if (
                    attempt >= this.maximumWriteAttempts ||
                    !this.isTransientWriteError(lastError)
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, attempt * 150));
            }
        }
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
            `${channel} write failed after ${attempted} attempt${attempted === 1 ? '' : 's'}: ${detail}`,
        );
    }

    private isTransientWriteError(error: unknown): boolean {
        const name = error instanceof DOMException
            ? error.name
            : error instanceof Error
                ? error.name
                : '';
        const detail = error instanceof Error ? error.message : String(error);
        return (
            name === 'NetworkError' ||
            name === 'OperationError' ||
            name === 'UnknownError' ||
            /gatt.*(?:failed|busy|progress|disconnect)|temporar|network|reconnect first|characteristic.*no longer valid|retrieve.*characteristic.*after reconnect/i.test(detail)
        );
    }

    private isDisconnectedGATTError(error: unknown): boolean {
        const detail = error instanceof Error ? error.message : String(error);
        return (
            this.bleDevice?.gatt?.connected === false ||
            /gatt server is disconnected|cannot perform gatt operation|gatt operation failed(?: for unknown reason)?|reconnect first|not connected|characteristic.*no longer valid|retrieve.*characteristic.*after reconnect/i.test(detail)
        );
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
                    this.connectionStates === ConnectionState.Connected &&
                    this.bleDevice?.gatt?.connected) {
                    if (await this.checkPrompt()) return true;
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
        } finally {
            this.suppressManagerCallback = false;
        }
    }
}
