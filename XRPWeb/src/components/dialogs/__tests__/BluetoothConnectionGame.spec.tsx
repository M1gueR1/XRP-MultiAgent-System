import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BLERobotFleetSnapshot, BLERobotSessionSnapshot } from '@/connections/bluetoothFleetTypes';
import BluetoothConnectionGame from '../BluetoothConnectionGame';
import BluetoothConnectionGameDialog from '../BluetoothConnectionGameDialog';

const app = vi.hoisted(() => {
    const listeners = new Map<string, Set<(value: string) => void>>();
    return {
        snapshot: { supported: true, activeSessionId: null, sessions: [] } as BLERobotFleetSnapshot,
        listeners,
        getBluetoothIDEFleetSnapshot: () => app.snapshot,
        on: vi.fn((event: string, listener: (value: string) => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(listener);
        }),
        eventOff: vi.fn((event: string, listener: (value: string) => void) => listeners.get(event)?.delete(listener)),
        disconnectBluetoothRobot: vi.fn(),
    };
});

vi.mock('@/managers/appmgr', () => ({
    default: { getInstance: () => app },
    EventType: { EVENT_SHOWBLUETOOTH_CONNECTING: 'show', EVENT_HIDE_BLUETOOTH_CONNECTING: 'hide', EVENT_BLE_IDE_FLEET: 'fleet' },
}));

function emit(event: string, value = '') {
    act(() => app.listeners.get(event)?.forEach((listener) => listener(value)));
}

function session(sessionId: string, state: BLERobotSessionSnapshot['state'], error?: string): BLERobotSessionSnapshot {
    return { sessionId, state, alias: `XRP ${sessionId}`, runtimeState: 'idle', active: false, bluetoothContextPreloaded: false, programFiles: [], error };
}

function updateFleet(sessions: BLERobotSessionSnapshot[]) {
    app.snapshot = { supported: true, activeSessionId: null, sessions };
    emit('fleet', JSON.stringify(app.snapshot));
}

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
    app.listeners.clear();
    app.snapshot = { supported: true, activeSessionId: null, sessions: [] };
    app.disconnectBluetoothRobot.mockClear();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

describe('Bluetooth energy game', () => {
    it('has 25 cells, collects energy, and respawns it outside the robot cell', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        render(<BluetoothConnectionGame status="connecting" robotNames={[]} onClose={vi.fn()} />);
        const grid = screen.getByRole('grid');
        expect(screen.getAllByRole('gridcell')).toHaveLength(25);
        fireEvent.keyDown(grid, { key: 'ArrowRight' });
        expect(screen.getByTestId('energy-score')).toHaveTextContent('1');
        expect(screen.getByRole('gridcell', { name: 'XRP, row 3, column 4' })).toBeInTheDocument();
        expect(screen.getByRole('gridcell', { name: 'Energy, row 1, column 1' })).toBeInTheDocument();
        ['ArrowUp', 'ArrowUp', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft'].forEach((key) => fireEvent.keyDown(grid, { key }));
        expect(screen.getByTestId('energy-score')).toHaveTextContent('2');
        expect(screen.getByRole('gridcell', { name: 'Energy, row 1, column 2' })).toBeInTheDocument();
    });

    it('keeps the robot inside every board edge without wrapping', () => {
        render(<BluetoothConnectionGame status="connecting" robotNames={[]} onClose={vi.fn()} />);
        const grid = screen.getByRole('grid');
        ['ArrowLeft', 'ArrowUp'].forEach((key) => {
            for (let count = 0; count < 8; count++) fireEvent.keyDown(grid, { key });
        });
        expect(screen.getByRole('gridcell', { name: 'XRP, row 1, column 1' })).toBeInTheDocument();
        ['ArrowRight', 'ArrowDown'].forEach((key) => {
            for (let count = 0; count < 8; count++) fireEvent.keyDown(grid, { key });
        });
        expect(screen.getByRole('gridcell', { name: 'XRP, row 5, column 5' })).toBeInTheDocument();
    });

    it('supports directional buttons and isolates keyboard input from global robot controls', () => {
        const globalKey = vi.fn();
        document.addEventListener('keydown', globalKey);
        document.addEventListener('keyup', globalKey);
        try {
            render(<BluetoothConnectionGame status="connecting" robotNames={[]} onClose={vi.fn()} />);
            fireEvent.click(screen.getByRole('button', { name: 'Move right' }));
            expect(screen.getByTestId('energy-score')).toHaveTextContent('1');
            expect(screen.getByRole('grid')).toHaveFocus();
            fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowUp' });
            fireEvent.keyDown(screen.getByRole('grid'), { key: 'w', code: 'KeyW' });
            fireEvent.keyUp(screen.getByRole('grid'), { key: 'w', code: 'KeyW' });
            expect(globalKey).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('keydown', globalKey);
            document.removeEventListener('keyup', globalKey);
        }
    });

    it('shows actual elapsed time and stops its timer when connected', () => {
        vi.useFakeTimers();
        const { rerender } = render(<BluetoothConnectionGame status="connecting" robotNames={[]} onClose={vi.fn()} />);
        act(() => vi.advanceTimersByTime(3500));
        expect(screen.getByText('Elapsed: 3s')).toBeInTheDocument();
        rerender(<BluetoothConnectionGame status="connected" robotNames={[]} onClose={vi.fn()} />);
        act(() => vi.advanceTimersByTime(5000));
        expect(screen.getByText('Elapsed: 3s')).toBeInTheDocument();
    });
});

describe('Bluetooth connection game lifecycle', () => {
    it('does not open for USB or an already-connected Bluetooth robot', () => {
        app.snapshot.sessions = [session('A', 'connected')];
        render(<BluetoothConnectionGameDialog />);
        emit('usb-fleet', JSON.stringify({ sessions: [{ state: 'connecting' }] }));
        emit('connection-status', 'Connected');
        updateFleet([session('A', 'connected')]);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens after Bluetooth selection, preserves the score, and waits for full IDE initialization', () => {
        render(<BluetoothConnectionGameDialog />);
        emit('show');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByRole('grid')).toHaveFocus();
        fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowRight' });
        updateFleet([session('B', 'initializing')]);
        emit('connection-status', 'Connected');
        emit('hide');
        expect(screen.getByText('Initializing XRP...')).toBeInTheDocument();
        expect(screen.queryByText('XRP connected')).not.toBeInTheDocument();
        expect(screen.getByTestId('energy-score')).toHaveTextContent('1');
        updateFleet([session('B', 'connected')]);
        expect(screen.getByText('XRP connected')).toBeInTheDocument();
        expect(screen.getByTestId('energy-score')).toHaveTextContent('1');
        fireEvent.click(screen.getByText('Close window'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(app.disconnectBluetoothRobot).not.toHaveBeenCalled();
    });

    it('does not mistake another connected robot for the new connection and reports early GATT errors', () => {
        app.snapshot.sessions = [session('A', 'connected')];
        render(<BluetoothConnectionGameDialog />);
        emit('show');
        updateFleet([session('A', 'connected')]);
        expect(screen.getByText('Connecting Bluetooth...')).toBeInTheDocument();
        updateFleet([session('A', 'connected'), session('B', 'error', 'GATT operation failed')]);
        expect(screen.getByText('Connection needs attention')).toBeInTheDocument();
        expect(screen.getByText('GATT operation failed')).toBeInTheDocument();
        expect(screen.queryByText('XRP connected')).not.toBeInTheDocument();
        fireEvent.click(screen.getByText('Close window'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('reports a Bluetooth failure before the legacy connection has created a fleet record', async () => {
        render(<BluetoothConnectionGameDialog />);
        emit('show');
        emit('hide');
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByText('Connection needs attention')).toBeInTheDocument();
        expect(screen.queryByText('XRP connected')).not.toBeInTheDocument();
        fireEvent.click(screen.getByText('Close window'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('can dismiss a pending attempt without disconnecting or reopening on phase changes', () => {
        render(<BluetoothConnectionGameDialog />);
        emit('show');
        fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
        updateFleet([session('A', 'connecting')]);
        updateFleet([session('A', 'initializing')]);
        updateFleet([session('A', 'connected')]);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(app.disconnectBluetoothRobot).not.toHaveBeenCalled();
    });

    it('opens for reconnecting, handles Escape, and starts a fresh game for a new attempt', () => {
        app.snapshot.sessions = [session('A', 'connected')];
        const { unmount } = render(<BluetoothConnectionGameDialog />);
        updateFleet([session('A', 'reconnecting')]);
        fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowRight' });
        expect(screen.getByTestId('energy-score')).toHaveTextContent('1');
        fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        updateFleet([session('A', 'error', 'Retry needed')]);
        updateFleet([session('A', 'connecting')]);
        expect(screen.getByTestId('energy-score')).toHaveTextContent('0');
        unmount();
        expect([...app.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    });

    it('waits for all pending Bluetooth robots before reporting success', () => {
        render(<BluetoothConnectionGameDialog />);
        updateFleet([session('A', 'initializing'), session('B', 'connecting')]);
        updateFleet([session('A', 'connected'), session('B', 'initializing')]);
        expect(screen.queryByText('XRP connected')).not.toBeInTheDocument();
        updateFleet([session('A', 'connected'), session('B', 'connected')]);
        expect(screen.getByText('XRP connected')).toBeInTheDocument();
    });
});
