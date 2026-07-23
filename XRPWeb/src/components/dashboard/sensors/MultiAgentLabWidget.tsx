import { useEffect, useMemo, useRef, useState } from "react";
import {
  BROADCAST_ROBOT_ID,
  FleetBenchmark,
  getRobotFleetManager,
  MultiAgentTopic,
  encodeEmotionState,
  type FleetBenchmarkResult,
  type FleetSnapshot,
  type MessageQos,
} from "@/multiagent";
import AppMgr, { EventType } from "@/managers/appmgr";
import type { USBRobotFleetSnapshot } from "@/connections/usbFleetTypes";
import type { BLERobotFleetSnapshot } from "@/connections/bluetoothFleetTypes";
import type { MultiRobotEditorRequest } from "@/connections/ideRobotTypes";

const fleet = getRobotFleetManager();
const appMgr = AppMgr.getInstance();

function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function RuntimeDot({ running }: { running: boolean }) {
  return (
    <span
      title={running ? "Program running" : "Idle"}
      className={`inline-block h-2.5 w-2.5 rounded-full ${running ? "animate-pulse bg-yellow-300 shadow-[0_0_8px_rgba(250,204,21,0.9)]" : "bg-gray-500"}`}
    />
  );
}

export default function MultiAgentLabWidget() {
  const [snapshot, setSnapshot] = useState<FleetSnapshot>(() => fleet.snapshot());
  const [usbSnapshot, setUsbSnapshot] = useState<USBRobotFleetSnapshot>(() => appMgr.getUSBFleetSnapshot());
  const [bleIDESnapshot, setBleIDESnapshot] = useState<BLERobotFleetSnapshot>(() => appMgr.getBluetoothIDEFleetSnapshot());
  const [status, setStatus] = useState("Ready. Add each cable-connected XRP, then choose which robot owns the IDE files.");
  const [target, setTarget] = useState(String(BROADCAST_ROBOT_ID));
  const [topic, setTopic] = useState("0001");
  const [payload, setPayload] = useState("hello fleet");
  const [payloadMode, setPayloadMode] = useState<"text" | "number" | "hex">("text");
  const [qos, setQos] = useState<MessageQos>("reliable");
  const [frequency, setFrequency] = useState(20);
  const [benchmarkResult, setBenchmarkResult] = useState<FleetBenchmarkResult | null>(null);
  const benchmark = useMemo(() => new FleetBenchmark(fleet), []);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [showMultiEditorChoices, setShowMultiEditorChoices] = useState(false);
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

  const sendInspectorMessage = async () => {
    const targetId = Number(target);
    const topicId = Number.parseInt(topic.replace(/^0x/i, ""), 16);
    let bytes: Uint8Array;
    if (payloadMode === "number") {
      const numeric = Number(payload);
      if (!Number.isFinite(numeric)) throw new Error("Diagnostic number payload is invalid.");
      bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, numeric, true);
    } else if (payloadMode === "hex") {
      const normalized = payload.replace(/\s+/g, "");
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(normalized)) throw new Error("Hex payload must contain complete byte pairs.");
      bytes = Uint8Array.from(normalized.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
    } else {
      bytes = new TextEncoder().encode(payload);
    }
    if (targetId === BROADCAST_ROBOT_ID) {
      await fleet.broadcast({ topicId, payload: bytes, qos, ttlMs: qos === "latest" ? 250 : 2000 });
    } else {
      await fleet.publish({ targetRobotId: targetId, topicId, payload: bytes, qos, ttlMs: qos === "latest" ? 250 : 2000 });
    }
  };

  const stopBenchmark = () => {
    try {
      const result = benchmark.stop("physical");
      setBenchmarkResult(result);
      setBenchmarkRunning(false);
      setStatus("Benchmark stopped. Results are measured locally; no physical-rate claim is inferred.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
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

  return (
    <section className="h-full overflow-auto bg-black p-3 text-sm text-white">
      <div className="mb-4 rounded border-2 border-purple-500 bg-purple-950/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h2 className="text-lg font-semibold">Multi-XRP program</h2>
            <p className="text-xs text-gray-300">One editor tab, one program, and parallel Run across all assigned IDE robots.</p>
          </div>
          <button
            className="rounded bg-purple-700 px-3 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={connectedIDERobots.length < 2}
            onClick={() => setShowMultiEditorChoices((visible) => !visible)}
          >
            Control all connected XRPs ({connectedIDERobots.length})
          </button>
        </div>
        {connectedIDERobots.length < 2 && <p className="mt-2 text-xs text-yellow-300">Connect at least two robots in the USB or Bluetooth IDE fleet.</p>}
        {showMultiEditorChoices && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-purple-500 pt-3">
            <span className="text-sm">Create:</span>
            <button className="rounded border border-purple-300 px-3 py-2" onClick={() => createMultiRobotEditor("python")}>Python file</button>
            <button className="rounded border border-purple-300 px-3 py-2" onClick={() => createMultiRobotEditor("blockly")}>Blockly file</button>
            <span className="text-xs text-gray-300">Targets: {connectedIDERobots.map((robot) => robot.alias).join(", ")}</span>
          </div>
        )}
      </div>

      <div className="mb-4 rounded border border-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h2 className="text-lg font-semibold">USB robot fleet</h2>
            <p className="text-xs text-gray-300">No program is required on the XRP. Its normal MicroPython firmware handles the connection.</p>
          </div>
          <button className="rounded border border-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" disabled={!usbSnapshot.supported} onClick={() => void run(() => appMgr.addUSBRobot(), "USB XRP connected and selected for the IDE.")}>Add XRP by USB</button>
          <button className="rounded border border-white px-2 py-1" onClick={() => void run(() => appMgr.disconnectAllUSBRobots(), "All USB XRPs disconnected.")}>Disconnect USB fleet</button>
        </div>
        {!usbSnapshot.supported && <p className="mt-2 text-yellow-300">Web Serial is unavailable. Open the dashboard in Chrome or Edge using localhost or HTTPS.</p>}
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {usbSnapshot.sessions.length === 0 && <p className="text-gray-400">Connect both XRP robots by cable, then press “Add XRP by USB” once for each robot.</p>}
          {usbSnapshot.sessions.map((session) => (
            <article key={session.sessionId} className={`rounded border p-2 ${session.active ? "border-green-400 bg-green-950/30" : "border-gray-500 bg-gray-950"}`}>
              <div className="flex items-center justify-between gap-2">
                <strong className="flex items-center gap-2"><RuntimeDot running={session.runtimeState === "running"} />{session.alias}</strong>
                <span className={session.state === "connected" ? "text-green-400" : session.state === "error" ? "text-red-400" : "text-yellow-300"}>{session.state}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs text-gray-300">
                <dt>IDE files</dt><dd>{session.active ? "selected" : "not selected"}</dd>
                <dt>Program</dt><dd>{session.runtimeState}</dd>
                <dt>USB VID:PID</dt><dd>{session.usbVendorId?.toString(16).padStart(4, "0") ?? "----"}:{session.usbProductId?.toString(16).padStart(4, "0") ?? "----"}</dd>
              </dl>
              {session.error && <p className="mt-2 text-xs text-red-300">{session.error}</p>}
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                {session.state === "connected" && <button className="rounded border px-2 py-1 disabled:opacity-50" disabled={session.active} onClick={() => void run(() => appMgr.selectUSBRobot(session.sessionId), `${session.alias} now owns the IDE files, terminal, save, and run controls.`)}>{session.active ? "IDE files active" : "Open this XRP in IDE"}</button>}
                {(session.state === "disconnected" || session.state === "error") && <button className="rounded border px-2 py-1" onClick={() => void run(() => appMgr.reconnectUSBRobot(session.sessionId), `${session.alias} reconnected.`)}>Reconnect</button>}
                {session.state !== "disconnected" && <button className="rounded border px-2 py-1" onClick={() => void run(() => appMgr.disconnectUSBRobot(session.sessionId), `${session.alias} disconnected.`)}>Disconnect</button>}
                <button className="rounded border px-2 py-1" onClick={() => { const alias = window.prompt("Robot alias", session.alias); if (alias) { try { appMgr.renameUSBRobot(session.sessionId, alias); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } } }}>Rename</button>
                <button className="rounded border border-red-400 px-2 py-1 text-red-300" onClick={() => void run(() => appMgr.removeUSBRobot(session.sessionId), `${session.alias} removed.`)}>Remove</button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded border border-cyan-300 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h2 className="text-lg font-semibold">Bluetooth IDE robot fleet</h2>
            <p className="text-xs text-gray-300">Full files, terminal, Save and Run over the XRP firmware BLE REPL. No user program or cable required.</p>
          </div>
          <button className="rounded border border-cyan-300 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" disabled={!bleIDESnapshot.supported} onClick={() => void run(() => appMgr.addBluetoothIDERobot(), "Bluetooth XRP connected and selected for the IDE.")}>Add XRP by Bluetooth</button>
          <button className="rounded border border-cyan-300 px-2 py-1" onClick={() => void run(() => appMgr.disconnectAllBluetoothIDERobots(), "All Bluetooth IDE XRPs disconnected.")}>Disconnect Bluetooth fleet</button>
        </div>
        {!bleIDESnapshot.supported && <p className="mt-2 text-yellow-300">Web Bluetooth is unavailable. Open the dashboard in Chrome or Edge using localhost or HTTPS.</p>}
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {bleIDESnapshot.sessions.length === 0 && <p className="text-gray-400">Turn on both battery-powered XRPs, then press “Add XRP by Bluetooth” once for each robot.</p>}
          {bleIDESnapshot.sessions.map((session) => (
            <article key={session.sessionId} className={`rounded border p-2 ${session.active ? "border-green-400 bg-green-950/30" : "border-cyan-800 bg-gray-950"}`}>
              <div className="flex items-center justify-between gap-2">
                <strong className="flex items-center gap-2"><RuntimeDot running={session.runtimeState === "running"} />{session.alias}</strong>
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
                {session.state === "connected" && <button className="rounded border px-2 py-1 disabled:opacity-50" disabled={session.active} onClick={() => void run(() => appMgr.selectBluetoothIDERobot(session.sessionId), `${session.alias} now owns the IDE files, terminal, save, and run controls.`)}>{session.active ? "IDE files active" : "Open this XRP in IDE"}</button>}
                {(session.state === "disconnected" || session.state === "error") && <button className="rounded border px-2 py-1" onClick={() => void run(() => appMgr.reconnectBluetoothIDERobot(session.sessionId), `${session.alias} reconnected over Bluetooth.`)}>Reconnect</button>}
                {session.state !== "disconnected" && <button className="rounded border px-2 py-1" onClick={() => void run(() => appMgr.disconnectBluetoothIDERobot(session.sessionId), `${session.alias} disconnected.`)}>Disconnect</button>}
                <button className="rounded border px-2 py-1" onClick={() => { const alias = window.prompt("Robot alias", session.alias); if (alias) { try { appMgr.renameBluetoothIDERobot(session.sessionId, alias); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } } }}>Rename</button>
                <button className="rounded border border-red-400 px-2 py-1 text-red-300" onClick={() => void run(() => appMgr.removeBluetoothIDERobot(session.sessionId), `${session.alias} removed.`)}>Remove</button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-white pb-3">
        <div className="mr-auto"><h2 className="text-lg font-semibold">BLE message runtime</h2><p className="text-xs text-gray-400">Robot-to-robot routing through the laptop. Shared Blockly/Python programs install and attach MultiAgentLib automatically.</p></div>
        <button className="rounded border border-white px-2 py-1" onClick={() => void run(() => fleet.addBluetoothRobot().then(() => undefined), "BLE runtime XRP added; waiting for handshake.")}>Add BLE runtime XRP</button>
        <button className="rounded border border-white px-2 py-1" onClick={() => void run(() => fleet.broadcast({ topicId: MultiAgentTopic.SYSTEM_TEST, payload: new TextEncoder().encode("broadcast test"), qos: "reliable", ttlMs: 2000 }), "Broadcast test sent.")}>Broadcast test</button>
        <button className="rounded border border-white px-2 py-1" onClick={() => void run(() => fleet.disconnectAll(), "Fleet disconnected.")}>Disconnect all</button>
        {!benchmarkRunning ? (
          <button className="rounded border border-white px-2 py-1" onClick={() => { try { benchmark.start(frequency); setBenchmarkRunning(true); setStatus("Benchmark running."); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } }}>Start benchmark</button>
        ) : (
          <button className="rounded border border-red-400 px-2 py-1 text-red-300" onClick={stopBenchmark}>Stop benchmark</button>
        )}
        <label className="flex items-center gap-1">Hz<input className="w-14 rounded border border-white bg-black px-1" type="number" min={10} max={25} value={frequency} onChange={(event) => setFrequency(Number(event.target.value))} /></label>
        {benchmarkResult && <button className="rounded border border-white px-2 py-1" onClick={() => downloadJson(benchmarkResult, "xrp-fleet-benchmark.json")}>Export benchmark</button>}
      </div>

      <p className="mb-3 rounded border border-gray-600 bg-gray-950 p-2 text-gray-300">{status}</p>

      <div className="mb-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {snapshot.sessions.length === 0 && <p className="text-gray-400">No fleet robots. Each Add XRP press opens one browser device chooser.</p>}
        {snapshot.sessions.map((session) => (
          <article key={session.sessionId} className="rounded border border-white bg-gray-950 p-2">
            <div className="flex items-center justify-between gap-2">
              <strong>{session.alias}</strong>
              <span className={session.health === "healthy" ? "text-green-400" : session.health === "degraded" ? "text-yellow-400" : "text-red-400"}>{session.state} / {session.health}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs text-gray-300">
              <dt>Robot ID</dt><dd>{session.robotId ?? "unassigned"}</dd>
              <dt>Hardware</dt><dd className="truncate">{session.hardwareIdentity ?? "waiting"}</dd>
              <dt>BLE device</dt><dd className="truncate">{session.deviceName ?? "unknown"}</dd>
              <dt>Handshake</dt><dd>{session.state === "ready" ? "complete" : session.state}</dd>
              <dt>Active legacy</dt><dd>{session.activeLegacyRobot ? "yes" : "no"}</dd>
              <dt>Last seen</dt><dd>{session.metrics.lastReceivedAt ? new Date(session.metrics.lastReceivedAt).toLocaleTimeString() : "never"}</dd>
              <dt>RTT latest / p95</dt><dd>{session.metrics.latestRttMs?.toFixed(1) ?? "—"} / {session.metrics.rttP95Ms?.toFixed(1) ?? "—"} ms</dd>
              <dt>TX / RX</dt><dd>{session.metrics.messagesSent} / {session.metrics.messagesReceived}</dd>
              <dt>Dropped / coalesced</dt><dd>{session.metrics.messagesDropped} / {session.metrics.messagesCoalesced}</dd>
              <dt>Disconnects / reconnects</dt><dd>{session.metrics.disconnectCount} / {session.metrics.reconnectCount}</dd>
              <dt>Queue depth</dt><dd>{session.metrics.outgoingQueueDepth}</dd>
            </dl>
            <div className="mt-2 flex flex-wrap gap-1 text-xs">
              {session.state === "disconnected" || session.state === "error" ? <button className="rounded border px-2 py-1" onClick={() => void run(() => fleet.connectRobot(session.sessionId), "Reconnect started.")}>Reconnect</button> : <button className="rounded border px-2 py-1" onClick={() => void run(() => fleet.disconnectRobot(session.sessionId), "Robot disconnected.")}>Disconnect</button>}
              {session.robotId !== undefined && <button className="rounded border px-2 py-1" onClick={() => void run(() => fleet.ping(session.robotId!), "Ping sent.")}>Ping</button>}
              {session.robotId !== undefined && <button className="rounded border px-2 py-1" onClick={() => fleet.setActiveLegacyRobot(session.robotId!)}>Set active fleet robot</button>}
              <button className="rounded border px-2 py-1" onClick={() => { const alias = window.prompt("Robot alias", session.alias); if (alias) fleet.renameRobot(session.sessionId, alias); }}>Rename</button>
              <button className="rounded border border-red-400 px-2 py-1 text-red-300" onClick={() => void run(() => fleet.removeRobot(session.sessionId), "Robot removed from fleet.")}>Remove</button>
            </div>
          </article>
        ))}
      </div>

      <fieldset className="mb-4 rounded border border-white p-2">
        <legend className="px-1 font-semibold">Message inspector</legend>
        <div className="grid gap-2 md:grid-cols-5">
          <label>Target<select className="block w-full rounded border border-white bg-black p-1" value={target} onChange={(event) => setTarget(event.target.value)}><option value={BROADCAST_ROBOT_ID}>Broadcast</option>{snapshot.sessions.filter((session) => session.robotId !== undefined).map((session) => <option key={session.sessionId} value={session.robotId}>{session.alias} ({session.robotId})</option>)}</select></label>
          <label>Topic hex<input className="block w-full rounded border border-white bg-black p-1" value={topic} onChange={(event) => setTopic(event.target.value)} /></label>
          <label>Payload type<select className="block w-full rounded border border-white bg-black p-1" value={payloadMode} onChange={(event) => setPayloadMode(event.target.value as "text" | "number" | "hex")}><option value="text">Text</option><option value="number">Number (float64)</option><option value="hex">Hex bytes</option></select></label>
          <label>Payload<input className="block w-full rounded border border-white bg-black p-1" value={payload} onChange={(event) => setPayload(event.target.value)} /></label>
          <label>QoS<select className="block w-full rounded border border-white bg-black p-1" value={qos} onChange={(event) => setQos(event.target.value as MessageQos)}><option value="reliable">Reliable</option><option value="latest">Latest only</option><option value="normal">Normal</option></select></label>
        </div>
        <button className="mt-2 rounded border border-white px-3 py-1" onClick={() => void run(sendInspectorMessage, "Inspector message sent.")}>Send message</button>
      </fieldset>

      <div className="rounded border border-white p-2">
        <h3 className="mb-1 font-semibold">Bounded routing log</h3>
        <div className="max-h-48 overflow-auto font-mono text-xs">
          {snapshot.routingLog.map((entry) => <div key={entry.id} className="grid grid-cols-[5rem_3rem_1rem_3rem_4rem_1fr] gap-1 border-t border-gray-800 py-1"><span>{new Date(entry.time).toLocaleTimeString()}</span><span>{entry.sourceRobotId}</span><span>→</span><span>{entry.targetRobotId}</span><span>0x{entry.topicId.toString(16).padStart(4, "0")}</span><span>{entry.status}{entry.rttMs !== undefined ? ` ${entry.rttMs.toFixed(1)}ms` : ""}</span></div>)}
        </div>
      </div>
    </section>
  );
}
