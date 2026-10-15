import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AppMgr, { EventType } from '@/managers/appmgr';
import type { BLERobotFleetSnapshot, BLERobotSessionSnapshot } from '@/connections/bluetoothFleetTypes';
import BluetoothConnectionGame, { type BluetoothGameStatus } from './BluetoothConnectionGame';

type Attempt = {
    id: number;
    sessionIds: string[];
    baselineIds: string[];
    awaitingSession: boolean;
    dismissed: boolean;
};

function isPending(session: BLERobotSessionSnapshot) {
    return session.state === 'connecting' || session.state === 'initializing' || session.state === 'reconnecting';
}

export default function BluetoothConnectionGameDialog() {
    const [snapshot, setSnapshot] = useState(() => AppMgr.getInstance().getBluetoothIDEFleetSnapshot());
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const snapshotRef = useRef(snapshot);
    const attemptRef = useRef<Attempt | null>(null);
    const nextId = useRef(0);
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const app = AppMgr.getInstance();
        let subscribed = true;
        function publish(next: Attempt) {
            attemptRef.current = next;
            setAttempt(next);
        }
        function begin(current: BLERobotFleetSnapshot, awaitingSession: boolean) {
            publish({
                id: ++nextId.current,
                sessionIds: current.sessions.filter(isPending).map((session) => session.sessionId),
                baselineIds: current.sessions.map((session) => session.sessionId),
                awaitingSession,
                dismissed: false,
            });
        }
        function handleShow() {
            const current = app.getBluetoothIDEFleetSnapshot();
            snapshotRef.current = current;
            setSnapshot(current);
            begin(current, current.sessions.every((session) => !isPending(session)));
        }
        function handleFleet(serialized: string) {
            const next = JSON.parse(serialized) as BLERobotFleetSnapshot;
            const previous = snapshotRef.current;
            snapshotRef.current = next;
            setSnapshot(next);
            const current = attemptRef.current;
            const newlyPending = next.sessions.filter((session) => isPending(session) && !previous.sessions.some((old) => old.sessionId === session.sessionId && isPending(old)));
            if (current?.awaitingSession) {
                // The chooser opens the game before GATT creates a fleet record.
                const selected = next.sessions.filter((session) => !current.baselineIds.includes(session.sessionId) || isPending(session));
                if (selected.length > 0) {
                    publish({ ...current, sessionIds: selected.map((session) => session.sessionId), awaitingSession: false });
                }
                return;
            }
            const wasFinished = current && previous.sessions.filter((session) => current.sessionIds.includes(session.sessionId)).every((session) => !isPending(session));
            if (newlyPending.length > 0 && (!current || current.dismissed || wasFinished)) {
                begin(next, false);
            } else if (newlyPending.length > 0 && current) {
                publish({ ...current, sessionIds: [...new Set([...current.sessionIds, ...newlyPending.map((session) => session.sessionId)])] });
            }
        }
        function handleHide() {
            const endedAttemptId = attemptRef.current?.id;
            // Initialization emits hide just before its final fleet snapshot.
            // Only an attempt that never created a fleet record needs a fallback.
            queueMicrotask(() => {
                if (!subscribed) return;
                const current = attemptRef.current;
                if (current && current.id === endedAttemptId && current.awaitingSession) {
                    publish({ ...current, awaitingSession: false });
                }
            });
        }
        app.on(EventType.EVENT_SHOWBLUETOOTH_CONNECTING, handleShow);
        app.on(EventType.EVENT_HIDE_BLUETOOTH_CONNECTING, handleHide);
        app.on(EventType.EVENT_BLE_IDE_FLEET, handleFleet);
        const initial = app.getBluetoothIDEFleetSnapshot();
        snapshotRef.current = initial;
        setSnapshot(initial);
        if (initial.sessions.some(isPending)) begin(initial, false);
        return () => {
            subscribed = false;
            app.eventOff(EventType.EVENT_SHOWBLUETOOTH_CONNECTING, handleShow);
            app.eventOff(EventType.EVENT_HIDE_BLUETOOTH_CONNECTING, handleHide);
            app.eventOff(EventType.EVENT_BLE_IDE_FLEET, handleFleet);
        };
    }, []);

    const visible = attempt !== null && !attempt.dismissed;
    useEffect(() => {
        if (!visible) return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const previousFocus = document.activeElement;
        if (!dialog.open) dialog.showModal();
        dialog.querySelector<HTMLElement>('[data-energy-grid]')?.focus();
        return () => {
            if (dialog.open) dialog.close();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, [visible, attempt?.id]);

    function close() {
        const current = attemptRef.current;
        if (!current) return;
        const next = { ...current, dismissed: true };
        attemptRef.current = next;
        setAttempt(next);
    }

    if (!visible || !attempt) return null;
    const sessions = snapshot.sessions.filter((session) => attempt.sessionIds.includes(session.sessionId));
    let status: BluetoothGameStatus = 'connecting';
    if (!attempt.awaitingSession && sessions.length > 0) {
        if (sessions.some(isPending)) status = sessions.some((session) => session.state === 'initializing') ? 'initializing' : 'connecting';
        else if (sessions.length === attempt.sessionIds.length && sessions.every((session) => session.state === 'connected')) status = 'connected';
        else status = 'error';
    } else if (!attempt.awaitingSession) {
        status = 'error';
    }
    const error = sessions.find((session) => session.error)?.error ?? 'The XRP is disconnected. Close this window to reconnect or repair its connection.';

    return createPortal(
        <dialog ref={dialogRef} aria-labelledby="bluetooth-game-title" onCancel={(event) => { event.preventDefault(); close(); }} className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto rounded-md border border-mountain-mist-200 bg-[#000000] p-0 text-[#ffffff] shadow-xl backdrop:bg-[#000000]/70">
            <BluetoothConnectionGame key={attempt.id} status={status} robotNames={sessions.map((session) => session.alias)} error={error} onClose={close} />
        </dialog>,
        document.body,
    );
}
