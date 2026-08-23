import { useEffect, useRef, useState, type MouseEvent } from "react";
import { FaProjectDiagram, FaTrash } from "react-icons/fa";
import {
  BROADCAST_ROBOT_ID,
  getRobotFleetManager,
  MultiAgentTopic,
  encodeEmotionState,
  type FleetSnapshot,
} from "@/multiagent";
import AppMgr, { EventType } from "@/managers/appmgr";
import type { USBRobotFleetSnapshot } from "@/connections/usbFleetTypes";
import type { BLERobotFleetSnapshot } from "@/connections/bluetoothFleetTypes";
import type { IDERobotRuntimeState, MultiRobotEditorRequest } from "@/connections/ideRobotTypes";
import { useGridStackWidget } from "../hooks/useGridStackWidget";
import SensorCard from "./SensorCard";

const fleet = getRobotFleetManager();
const appMgr = AppMgr.getInstance();
const INITIAL_STATUS = "Ready. Add each cable-connected XRP, then choose which robot owns the IDE files.";

function RuntimeDot({ state }: { state: IDERobotRuntimeState }) {
  const title = state === "idle"
    ? "Idle"
    : state === "starting"
      ? "Preparing program"
      : state === "stopping"
        ? "Stopping program"
        : "Program running";
  const color = state === "idle"
    ? "bg-gray-500"
    : state === "starting"
      ? "animate-pulse bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]"
      : state === "stopping"
        ? "animate-pulse bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.9)]"
        : "animate-pulse bg-yellow-300 shadow-[0_0_8px_rgba(250,204,21,0.9)]";
  return <span title={title} className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

export default function MultiAgentLabWidget() {
  const { handleDelete } = useGridStackWidget();
  const [snapshot, setSnapshot] = useState<FleetSnapshot>(() => fleet.snapshot());
  const [usbSnapshot, setUsbSnapshot] = useState<USBRobotFleetSnapshot>(() => appMgr.getUSBFleetSnapshot());
  const [bleIDESnapshot, setBleIDESnapshot] = useState<BLERobotFleetSnapshot>(() => appMgr.getBluetoothIDEFleetSnapshot());
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [target, setTarget] = useState(String(BROADCAST_ROBOT_ID));
  const [showMessageTester, setShowMessageTester] = useState(false);
  const [showMultiEditorChoices, setShowMultiEditorChoices] = useState(false);
  const [preparingBluetoothSessionId, setPreparingBluetoothSessionId] = useState<string | null>(null);
  const currentDashboardEmotion = useRef<{ emotionId: number; generation: number } | null>(null);
  const deliveredEmotionGeneration = useRef(new Map<number, number>());
  const connectedIDERobots = [
    ...usbSnapshot.sessions.filter((session) => session.state === "connected").map((session) => ({ sessionId: session.sessionId, alias: session.alias })),
    ...bleIDESnapshot.sessions.filter((session) => session.state === "connected").map((session) => ({ sessionId: session.sessionId, alias: session.alias })),
  ];

  useEffect(() => {
    const unsubscribeFleet = fleet.subscribe(setSnapshot);
    const handleUSBFleet = (serialized: string) => setUsbSnapshot(JSON.parse(serialized) as USBRobotFleetSnapshot);
    const handleBLEIDEFleet = (serialized: string) => setBleIDESnapshot(JSON.parse(serialized) as BLERobotFleetSnapshot);
    appMgr.on(EventType.EVENT_USB_FLEET, handleUSBFleet);
    appMgr.on(EventType.EVENT_BLE_IDE_FLEET, handleBLEIDEFleet);
    setUsbSnapshot(appMgr.getUSBFleetSnapshot());
    setBleIDESnapshot(appMgr.getBluetoothIDEFleetSnapshot());
    return () => {
      unsubscribeFleet();
      appMgr.eventOff(EventType.EVENT_USB_FLEET, handleUSBFleet);
      appMgr.eventOff(EventType.EVENT_BLE_IDE_FLEET, handleBLEIDEFleet);
    };
  }, []);

  useEffect(() => {
    const publishEmotion = async (emotionId: number, generation: number, robotId?: number) => {
      const payload = encodeEmotionState({ emotionId, generation });
      if (robotId !== undefined) {
        deliveredEmotionGeneration.current.set(robotId, generation);
        try {
          await fleet.publish({
            targetRobotId: robotId,
            topicId: MultiAgentTopic.EMOTION_STATE,
            payload,
            qos: "reliable",
            ttlMs: 2000,
          });
        } catch (error) {
          if (deliveredEmotionGeneration.current.get(robotId) === generation) {
            deliveredEmotionGeneration.current.delete(robotId);
          }
          throw error;
        }
        return;
      }
      const readyIds = fleet.getReadySessions()
        .map((session) => session.robotId)
        .filter((id): id is number => id !== undefined);
      await Promise.all(readyIds.map((id) => publishEmotion(emotionId, generation, id)));
    };

    const handleEmotionPreview = (event: Event) => {
      const emotionId = (event as CustomEvent<{ emotionId?: number }>).detail?.emotionId;
      if (!Number.isInteger(emotionId) || emotionId === undefined || emotionId < 0 || emotionId > 255) return;
      const generation = ((currentDashboardEmotion.current?.generation ?? 0) + 1) & 0xffff;
      currentDashboardEmotion.current = { emotionId, generation };
      void publishEmotion(emotionId, generation).catch(() => undefined);
    };

    window.addEventListener("xrp:dashboard-emotion-preview", handleEmotionPreview);
    return () => window.removeEventListener("xrp:dashboard-emotion-preview", handleEmotionPreview);
  }, []);

  useEffect(() => {
    const current = currentDashboardEmotion.current;
    if (!current) return;
    for (const session of snapshot.sessions) {
      if (
        session.state === "ready" &&
        session.robotId !== undefined &&
        deliveredEmotionGeneration.current.get(session.robotId) !== current.generation
      ) {
        deliveredEmotionGeneration.current.set(session.robotId, current.generation);
        void fleet.publish({
          targetRobotId: session.robotId,
          topicId: MultiAgentTopic.EMOTION_STATE,
          payload: encodeEmotionState(current),
          qos: "reliable",
          ttlMs: 2000,
        }).catch(() => {
          if (deliveredEmotionGeneration.current.get(session.robotId!) === current.generation) {
            deliveredEmotionGeneration.current.delete(session.robotId!);
          }
        });
      }
    }
  }, [snapshot.sessions]);

  const run = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const prepareUSBForBluetooth = async (sessionId: string, alias: string) => {
    setPreparingBluetoothSessionId(sessionId);
    setStatus(`Preparing ${alias} for faster Bluetooth team runs...`);
    try {
      await appMgr.prepareUSBRobotForBluetooth(sessionId);
      setStatus(`${alias} is ready for Bluetooth. Disconnect its USB cable, connect it by Bluetooth, and run the team program.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingBluetoothSessionId(null);
    }
  };

  const sendTestMessage = async () => {
    const targetId = Number(target);
    try {
      if (targetId === BROADCAST_ROBOT_ID) {
        const readyRobotIds = snapshot.sessions
          .filter((session) => session.state === "ready" && session.robotId !== undefined)
          .map((session) => session.robotId!);
        if (readyRobotIds.length === 0) throw new Error("No ready robots are available for a test message.");
        await Promise.all(readyRobotIds.map((robotId) => fleet.ping(robotId)));
        setStatus(`Test message sent to ${readyRobotIds.length} robot${readyRobotIds.length === 1 ? "" : "s"}.`);
      } else {
        await fleet.ping(targetId);
        setStatus(`Test message sent to robot ${targetId}.`);
      }
      setShowMessageTester(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const openMessageTester = () => {
    const targetStillExists = target === String(BROADCAST_ROBOT_ID)
      || snapshot.sessions.some((session) => session.robotId !== undefined && String(session.robotId) === target);
    if (!targetStillExists) setTarget(String(BROADCAST_ROBOT_ID));
    setShowMessageTester(true);
  };

  const closeMessageTester = () => setShowMessageTester(false);

  const handleMessageTesterBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeMessageTester();
  };

  const createMultiRobotEditor = (fileType: "python" | "blockly") => {
    if (connectedIDERobots.length < 2) {
      setStatus("Connect at least two IDE robots before creating a multi-XRP program.");
      return;
    }
    const extension = fileType === "python" ? ".py" : ".blocks";
    const requestedName = window.prompt(
      `Name for the multi-XRP ${fileType === "python" ? "Python" : "Blockly"} file`,
      `multi_xrp_program${extension}`,
    );
    if (!requestedName) return;
    const safeBase = requestedName.trim().replace(/[\\/'"\r\n]/g, "_");
    if (!safeBase) {
      setStatus("Choose a non-empty file name.");
      return;
    }
    const name = safeBase.endsWith(extension) ? safeBase : `${safeBase}${extension}`;
    const request: MultiRobotEditorRequest = {
      fileType,
      name,
      sessionIds: connectedIDERobots.map((robot) => robot.sessionId),
    };
    appMgr.emit(EventType.EVENT_CREATE_MULTI_ROBOT_EDITOR, JSON.stringify(request));
    setShowMultiEditorChoices(false);
    setStatus(`Multi-XRP ${fileType} tab created for ${connectedIDERobots.length} robots. Its Run button is purple.`);
  };

  const messageTargetOptions = snapshot.sessions
    .filter((session) => session.robotId !== undefined)
    .map((session) => (
      <option key={session.sessionId} value={String(session.robotId)}>
        {session.alias} ({session.robotId})
      </option>
    ));

  const readyMessageTargets = snapshot.sessions.some((session) => session.state === "ready" && session.robotId !== undefined);
  const routingRows = snapshot.routingLog.map((entry) => (
    <div key={entry.id} className="grid grid-cols-[5rem_3rem_1rem_3rem_4rem_1fr] gap-1 border-t border-gray-800 py-1">
      <span>{new Date(entry.time).toLocaleTimeString()}</span>
      <span>{entry.sourceRobotId}</span>
      <span>-&gt;</span>
      <span>{entry.targetRobotId}</span>
      <span>0x{entry.topicId.toString(16).padStart(4, "0")}</span>
      <span>{entry.status}{entry.rttMs !== undefined ? ` ${entry.rttMs.toFixed(1)}ms` : ""}</span>
    </div>
  ));

  const content = (
    <section className="flex h-full w-full flex-col gap-3 overflow-auto rounded-xl bg-black p-3 pt-1 text-xs text-white">
      <div className="rounded-xl border border-purple-500/70 bg-purple-950/20 p-3 shadow-[0_0_22px_rgba(168,85,247,0.12)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h2 className="text-base font-bold">Program All XRPs at Once</h2>
          </div>
          <button
            className="rounded-lg border border-purple-300 bg-purple-700 px-3 py-2 font-bold text-white transition hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={connectedIDERobots.length < 2}
            onClick={() => setShowMultiEditorChoices((visible) => !visible)}
          >
            Control all connected XRPs ({connectedIDERobots.length})
          </button>
        </div>
        {connectedIDERobots.length < 2 && <p className="mt-2 text-xs text-yellow-300">Connect at least two robots in the USB or Bluetooth IDE fleet.</p>}
        {showMultiEditorChoices && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-purple-400/60 pt-3">
            <span className="text-sm">Create:</span>
            <button className="rounded-lg border border-purple-300 bg-black px-3 py-2 font-bold text-white transition hover:bg-purple-500 hover:text-black" onClick={() => createMultiRobotEditor("python")}>Python file</button>
            <button className="rounded-lg border border-purple-300 bg-black px-3 py-2 font-bold text-white transition hover:bg-purple-500 hover:text-black" onClick={() => createMultiRobotEditor("blockly")}>Blockly file</button>
            <span className="text-xs text-gray-300">Targets: {connectedIDERobots.map((robot) => robot.alias).join(", ")}</span>
          </div>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-xl border border-white bg-black p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-base font-bold">USB Robot Fleet</h2>
            <button className="rounded-lg border border-white bg-black px-3 py-1.5 font-bold text-white transition hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-50" disabled={!usbSnapshot.supported} onClick={() => void run(() => appMgr.addUSBRobot(), "USB XRP connected and selected for the IDE.")}>Add XRP by USB</button>
            <button className="rounded-lg border border-white bg-black px-3 py-1.5 font-bold text-white transition hover:bg-white hover:text-black" onClick={() => void run(() => appMgr.disconnectAllUSBRobots(), "All USB XRPs disconnected.")}>Disconnect USB fleet</button>
          </div>
          {!usbSnapshot.supported && <p className="mt-2 text-yellow-300">Web Serial is unavailable. Open the dashboard in Chrome or Edge using localhost or HTTPS.</p>}
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {usbSnapshot.sessions.map((session) => (
            <article key={session.sessionId} className={`rounded-xl border p-2 ${session.active ? "border-green-400 bg-green-950/30" : "border-zinc-700 bg-zinc-950"}`}>
              <div className="flex items-center justify-between gap-2">
                <strong className="flex items-center gap-2"><RuntimeDot state={session.runtimeState} />{session.alias}</strong>
                <span className={session.state === "connected" ? "text-green-400" : session.state === "error" ? "text-red-400" : "text-yellow-300"}>{session.state}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs text-gray-300">
                <dt>IDE files</dt><dd>{session.active ? "selected" : "not selected"}</dd>
                <dt>Program</dt><dd>{session.runtimeState}</dd>
                <dt>USB VID:PID</dt><dd>{session.usbVendorId?.toString(16).padStart(4, "0") ?? "----"}:{session.usbProductId?.toString(16).padStart(4, "0") ?? "----"}</dd>
              </dl>
              {session.error && <p className="mt-2 text-xs text-red-300">{session.error}</p>}
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                {session.state === "connected" && <button className="rounded-lg border px-2 py-1 disabled:opacity-50" disabled={session.active} onClick={() => void run(() => appMgr.selectUSBRobot(session.sessionId), `${session.alias} now owns the IDE files, terminal, save, and run controls.`)}>{session.active ? "IDE files active" : "Open this XRP in IDE"}</button>}
                {session.state === "connected" && <button className="rounded-lg border border-cyan-300 px-2 py-1 text-cyan-100 transition hover:bg-cyan-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50" disabled={session.runtimeState !== "idle" || preparingBluetoothSessionId !== null} onClick={() => void prepareUSBForBluetooth(session.sessionId, session.alias)}>{preparingBluetoothSessionId === session.sessionId ? "Preparing..." : "Prepare for Bluetooth"}</button>}
                {(session.state === "disconnected" || session.state === "error") && <button className="rounded-lg border px-2 py-1" onClick={() => void run(() => appMgr.reconnectUSBRobot(session.sessionId), `${session.alias} reconnected.`)}>Reconnect</button>}
                {session.state !== "disconnected" && <button className="rounded-lg border px-2 py-1" onClick={() => void run(() => appMgr.disconnectUSBRobot(session.sessionId), `${session.alias} disconnected.`)}>Disconnect</button>}
                <button className="rounded-lg border px-2 py-1" onClick={() => { const alias = window.prompt("Robot alias", session.alias); if (alias) { try { appMgr.renameUSBRobot(session.sessionId, alias); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } } }}>Rename</button>
                <button className="rounded-lg border border-red-400 px-2 py-1 text-red-300" onClick={() => void run(() => appMgr.removeUSBRobot(session.sessionId), `${session.alias} removed.`)}>Remove</button>
              </div>
            </article>
          ))}
          </div>
        </div>

        <div className="rounded-xl border border-cyan-500/70 bg-black p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-base font-bold">Bluetooth IDE Robot Fleet</h2>
            <button className="rounded-lg border border-cyan-300 bg-black px-3 py-1.5 font-bold text-white transition hover:bg-cyan-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50" disabled={!bleIDESnapshot.supported} onClick={() => void run(() => appMgr.addBluetoothIDERobot(), "Bluetooth XRP connected and selected for the IDE.")}>Add XRP by Bluetooth</button>
            <button className="rounded-lg border border-cyan-300 bg-black px-3 py-1.5 font-bold text-white transition hover:bg-cyan-500 hover:text-black" onClick={() => void run(() => appMgr.disconnectAllBluetoothIDERobots(), "All Bluetooth IDE XRPs disconnected.")}>Disconnect Bluetooth fleet</button>
          </div>
          {!bleIDESnapshot.supported && <p className="mt-2 text-yellow-300">Web Bluetooth is unavailable. Open the dashboard in Chrome or Edge using localhost or HTTPS.</p>}
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {bleIDESnapshot.sessions.map((session) => (
            <article key={session.sessionId} className={`rounded-xl border p-2 ${session.active ? "border-green-400 bg-green-950/30" : "border-cyan-800 bg-zinc-950"}`}>
              <div className="flex items-center justify-between gap-2">
                <strong className="flex items-center gap-2"><RuntimeDot state={session.runtimeState} />{session.alias}</strong>
                <span className={session.state === "connected" ? "text-green-400" : session.state === "error" ? "text-red-400" : "text-yellow-300"}>{session.state}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs text-gray-300">
                <dt>IDE files</dt><dd>{session.active ? "selected" : "not selected"}</dd>
                <dt>Program</dt><dd>{session.runtimeState}</dd>
                <dt>BLE device</dt><dd className="truncate">{session.deviceName ?? "XRP"}</dd>
                <dt>Browser ID</dt><dd className="truncate">{session.browserDeviceId ?? "unknown"}</dd>
              </dl>
              {session.error && <p className="mt-2 text-xs text-red-300">{session.error}</p>}
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                {session.state === "connected" && <button className="rounded-lg border px-2 py-1 disabled:opacity-50" disabled={session.active} onClick={() => void run(() => appMgr.selectBluetoothIDERobot(session.sessionId), `${session.alias} now owns the IDE files, terminal, save, and run controls.`)}>{session.active ? "IDE files active" : "Open this XRP in IDE"}</button>}
                {(session.state === "disconnected" || session.state === "error") && <button className="rounded-lg border px-2 py-1" onClick={() => void run(() => appMgr.reconnectBluetoothIDERobot(session.sessionId), `${session.alias} reconnected over Bluetooth.`)}>Reconnect</button>}
                {session.state !== "disconnected" && <button className="rounded-lg border px-2 py-1" onClick={() => void run(() => appMgr.disconnectBluetoothIDERobot(session.sessionId), `${session.alias} disconnected.`)}>Disconnect</button>}
                <button className="rounded-lg border px-2 py-1" onClick={() => { const alias = window.prompt("Robot alias", session.alias); if (alias) { try { appMgr.renameBluetoothIDERobot(session.sessionId, alias); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } } }}>Rename</button>
                <button className="rounded-lg border border-red-400 px-2 py-1 text-red-300" onClick={() => void run(() => appMgr.removeBluetoothIDERobot(session.sessionId), `${session.alias} removed.`)}>Remove</button>
              </div>
            </article>
          ))}
          </div>
        </div>
      </div>

      {status !== INITIAL_STATUS && <p className="rounded-xl border border-zinc-700 bg-zinc-950 p-2 text-zinc-300">{status}</p>}

      <div className="rounded-xl border border-yellow-300/80 bg-zinc-950 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-semibold text-yellow-100">Team Message Log</h3>
          <button className="rounded-lg border border-yellow-300 bg-black px-3 py-1 text-xs font-bold text-yellow-100 transition hover:bg-yellow-300 hover:text-black" onClick={openMessageTester}>
            Test message
          </button>
        </div>
        <div className="max-h-48 overflow-auto font-mono text-xs">
          {routingRows.length > 0 ? routingRows : <p className="py-2 font-sans text-gray-400">No messages routed yet.</p>}
        </div>
      </div>

      {showMessageTester && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="presentation"
          onMouseDown={handleMessageTesterBackdrop}
        >
          <div className="w-full max-w-md rounded border border-yellow-300 bg-black p-4 text-white shadow-[0_0_24px_rgba(250,204,21,0.18)]">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">Send Test Message</h3>
                <p className="mt-1 text-xs text-gray-300">Send a ping through the laptop router to check that the selected XRP is reachable.</p>
              </div>
              <button className="rounded border border-gray-500 px-2 py-1 text-xs" onClick={closeMessageTester}>Close</button>
            </div>
            <label className="block text-sm">
              Target
              <select
                className="mt-1 block w-full rounded border border-white bg-black p-2"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value={String(BROADCAST_ROBOT_ID)}>Broadcast</option>
                {messageTargetOptions}
              </select>
            </label>
            <button
              className="mt-4 w-full rounded bg-yellow-300 px-3 py-2 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!readyMessageTargets}
              onClick={() => void sendTestMessage()}
            >
              Send message
            </button>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <SensorCard
      title="Multi-Agent Lab"
      icon={<FaProjectDiagram />}
      onStart={() => {}}
      onStop={() => {}}
      isConnected={connectedIDERobots.length > 0}
    >
      <div className="absolute right-4 top-4">
        <button
          onClick={handleDelete}
          className="rounded border border-red-400 bg-black p-2 text-red-300 transition hover:bg-red-500 hover:text-white"
          title="Delete widget"
          type="button"
        >
          <FaTrash size={12} />
        </button>
      </div>
      {content}
    </SensorCard>
  );
}
