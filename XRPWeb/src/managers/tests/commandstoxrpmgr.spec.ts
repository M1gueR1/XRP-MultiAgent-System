import type Connection from '@/connections/connection';
import { CommandToXRPMgr } from '@/managers/commandstoxrpmgr';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('CommandToXRPMgr session isolation', () => {
    it('finishes a battery check on the connection where it started', async () => {
        const result = deferred<string[]>();
        const first = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(() => result.promise),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const second = {
            isConnected: () => true,
            writeUtilityCmdRaw: vi.fn(async () => ['OK0']),
            getToNormal: vi.fn(async () => undefined),
        } as unknown as Connection;
        const commands = new CommandToXRPMgr(false);
        commands.setConnection(first);

        const voltagePromise = commands.batteryVoltage();
        await Promise.resolve();
        commands.setConnection(second);
        result.resolve(['OK32768']);

        await expect(voltagePromise).resolves.toBeCloseTo(7, 3);
        expect(first.writeUtilityCmdRaw).toHaveBeenCalledOnce();
        expect(first.getToNormal).toHaveBeenCalledOnce();
        expect(second.writeUtilityCmdRaw).not.toHaveBeenCalled();
        expect(second.getToNormal).not.toHaveBeenCalled();
    });
});
