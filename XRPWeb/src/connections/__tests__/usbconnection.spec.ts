import type ConnectionMgr from '@/managers/connectionmgr';
import { USBConnection } from '@/connections/usbconnection';
import { describe, expect, it, vi } from 'vitest';

describe('USBConnection manual selection', () => {
    it('uses the port selected by the repair flow without opening another chooser', async () => {
        const originalSerial = Object.getOwnPropertyDescriptor(navigator, 'serial');
        const requestPort = vi.fn();
        Object.defineProperty(navigator, 'serial', {
            configurable: true,
            value: { requestPort, addEventListener: vi.fn() },
        });
        const selectedPort = {
            getInfo: () => ({ usbVendorId: 6991, usbProductId: 70 }),
        } as SerialPort;
        const connection = new USBConnection(
            { isUSBPortClaimed: () => false } as unknown as ConnectionMgr,
            { manualOnly: true },
        );
        Object.assign(connection, {
            openPort: vi.fn(async () => true),
            onConnected: vi.fn(async () => undefined),
        });

        try {
            await connection.connect(selectedPort);
            expect(requestPort).not.toHaveBeenCalled();
        } finally {
            if (originalSerial) {
                Object.defineProperty(navigator, 'serial', originalSerial);
            } else {
                Reflect.deleteProperty(navigator, 'serial');
            }
        }
    });

    it('does not auto-open an authorized port after a device connect event', async () => {
        const originalSerial = Object.getOwnPropertyDescriptor(navigator, 'serial');
        let connectHandler: EventListener | undefined;
        const getPorts = vi.fn(async () => [] as SerialPort[]);
        const serial = {
            addEventListener: vi.fn((type: string, handler: EventListener) => {
                if (type === 'connect') connectHandler = handler;
            }),
            getPorts,
        };
        Object.defineProperty(navigator, 'serial', {
            configurable: true,
            value: serial,
        });

        try {
            new USBConnection({} as ConnectionMgr, { manualOnly: true });
            expect(connectHandler).toBeDefined();

            connectHandler?.(new Event('connect'));
            await Promise.resolve();

            expect(getPorts).not.toHaveBeenCalled();
        } finally {
            if (originalSerial) {
                Object.defineProperty(navigator, 'serial', originalSerial);
            } else {
                Reflect.deleteProperty(navigator, 'serial');
            }
        }
    });
});
