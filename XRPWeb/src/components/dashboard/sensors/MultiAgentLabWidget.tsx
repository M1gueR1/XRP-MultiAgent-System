import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaProjectDiagram, FaTrash } from "react-icons/fa";
import {
  getRobotFleetManager,
  MultiAgentTopic,
  encodeEmotionState,
  type FleetSnapshot,
} from "@/multiagent";
import AppMgr, { EventType } from "@/managers/appmgr";
import type { USBRobotFleetSnapshot } from "@/connections/usbFleetTypes";
import type { BLERobotFleetSnapshot } from "@/connections/bluetoothFleetTypes";
import type { IDERobotRuntimeState, PreferredRobotProgramRequest } from "@/connections/ideRobotTypes";
import { useGridStackWidget } from "../hooks/useGridStackWidget";
import { useGridStackContext } from "../lib";
import SensorCard from "./SensorCard";
import TeamMessageLog from "./TeamMessageLog";

const fleet = getRobotFleetManager();
const appMgr = AppMgr.getInstance();
const INITIAL_STATUS = "Ready. Add each cable-connected XRP, then choose which robot owns the IDE files.";
const PREFERRED_PROGRAMS_STORAGE_KEY = "xrp-multiagent-preferred-programs-v1";
const PREFERRED_FOLDERS_STORAGE_KEY = "xrp-multiagent-preferred-folders-v1";

type BLERepairDialog = {
  sessionId: string;
  alias: string;
  stage: "disconnecting" | "ready" | "working" | "complete" | "error";
  progress: number;
  message: string;
  backupPath?: string;
};

function readPreferredPrograms(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERRED_PROGRAMS_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writePreferredPrograms(programs: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PREFERRED_PROGRAMS_STORAGE_KEY, JSON.stringify(programs));
}

function readPreferredFolders(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERRED_FOLDERS_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writePreferredFolders(folders: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PREFERRED_FOLDERS_STORAGE_KEY, JSON.stringify(folders));
}

function getProgramFolder(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function getProgramName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function getProgramFolders(programFiles: string[]): string[] {
  const folders = new Set<string>(["/"]);
  for (const path of programFiles) {
    let folder = getProgramFolder(path);
    while (true) {
      folders.add(folder);
      if (folder === "/") break;
      const separator = folder.lastIndexOf("/");
      folder = separator <= 0 ? "/" : folder.slice(0, separator);
    }
  }
  return [...folders].sort((first, second) => {
    if (first === "/") return -1;
    if (second === "/") return 1;
    return first.localeCompare(second);
  });
}

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
  const { addWidget, _rawWidgetMetaMap } = useGridStackContext();
  const [snapshot, setSnapshot] = useState<FleetSnapshot>(() => fleet.snapshot());
  const [usbSnapshot, setUsbSnapshot] = useState<USBRobotFleetSnapshot>(() => appMgr.getUSBFleetSnapshot());
  const [bleIDESnapshot, setBleIDESnapshot] = useState<BLERobotFleetSnapshot>(() => appMgr.getBluetoothIDEFleetSnapshot());
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [preparingBluetoothSessionId, setPreparingBluetoothSessionId] = useState<string | null>(null);
  const [preferredPrograms, setPreferredPrograms] = useState<Record<string, string>>(() => readPreferredPrograms());
  const [preferredFolders, setPreferredFolders] = useState<Record<string, string>>(() => readPreferredFolders());
  const [runChoiceEnabled, setRunChoiceEnabled] = useState(() => appMgr.isMultiRobotRunChoiceEnabled());
  const [repairingBLESessionId, setRepairingBLESessionId] = useState<string | null>(null);
  const [bleRepairDialog, setBLERepairDialog] = useState<BLERepairDialog | null>(null);
  const [bluetoothReadyAfterRepair, setBluetoothReadyAfterRepair] = useState<Record<string, boolean>>({});
  const [stalledBLESessions, setStalledBLESessions] = useState<string[]>([]);
  const currentDashboardEmotion = useRef<{ emotionId: number; generation: number } | null>(null);
  const deliveredEmotionGeneration = useRef(new Map<number, number>());
  const connectedIDERobots = [
    ...usbSnapshot.sessions.filter((session) => session.state === "connected").map((session) => ({
      sessionId: session.sessionId,
      alias: session.alias,
      runtimeState: session.runtimeState,
      programFiles: session.programFiles,
    })),
    ...bleIDESnapshot.sessions.filter((session) => session.state === "connected").map((session) => ({
      sessionId: session.sessionId,
      alias: session.alias,
      runtimeState: session.runtimeState,
      programFiles: session.programFiles,
    })),
  ];
  const pendingBLEKey = bleIDESnapshot.sessions
    .filter((session) => session.state === "connecting" || session.state === "reconnecting" || session.state === "initializing")
    .map((session) => `${session.sessionId}:${session.state}`)
    .join("|");

  useEffect(() => {
    const pendingIds = pendingBLEKey.split("|").filter(Boolean).map((entry) => entry.split(":")[0]);
    setStalledBLESessions((current) => current.filter((id) => pendingIds.includes(id)));
    if (pendingIds.length === 0) return;
    const timeout = window.setTimeout(() => {
      setStalledBLESessions((current) => [...new Set([...current, ...pendingIds])]);
    }, 30000);
    return () => window.clearTimeout(timeout);
  }, [pendingBLEKey]);

  useEffect(() => {
    const unsubscribeFleet = fleet.subscribe(setSnapshot);
    const handleUSBFleet = (serialized: string) => setUsbSnapshot(JSON.parse(serialized) as USBRobotFleetSnapshot);
    const handleBLEIDEFleet = (serialized: string) => setBleIDESnapshot(JSON.parse(serialized) as BLERobotFleetSnapshot);
    const handleRunChoiceMode = (state: string) => setRunChoiceEnabled(state === "on");
    appMgr.on(EventType.EVENT_USB_FLEET, handleUSBFleet);
    appMgr.on(EventType.EVENT_BLE_IDE_FLEET, handleBLEIDEFleet);
    appMgr.on(EventType.EVENT_MULTI_ROBOT_RUN_CHOICE, handleRunChoiceMode);
    setUsbSnapshot(appMgr.getUSBFleetSnapshot());
    setBleIDESnapshot(appMgr.getBluetoothIDEFleetSnapshot());
    setRunChoiceEnabled(appMgr.isMultiRobotRunChoiceEnabled());
    return () => {
      unsubscribeFleet();
      appMgr.eventOff(EventType.EVENT_USB_FLEET, handleUSBFleet);
      appMgr.eventOff(EventType.EVENT_BLE_IDE_FLEET, handleBLEIDEFleet);
      appMgr.eventOff(EventType.EVENT_MULTI_ROBOT_RUN_CHOICE, handleRunChoiceMode);
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

  const openBLERepair = async (sessionId: string, alias: string) => {
    setRepairingBLESessionId(sessionId);
    setBLERepairDialog({ sessionId, alias, stage: "disconnecting", progress: 5, message: "Disconnecting Bluetooth..." });
    try {
      await appMgr.disconnectBluetoothIDERobot(sessionId);
      setBLERepairDialog((current) => current?.sessionId === sessionId
        ? { ...current, stage: "ready", progress: 10, message: "Connect this XRP by USB, then grant USB access." }
        : current);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setBLERepairDialog((current) => current?.sessionId === sessionId
        ? { ...current, stage: "error", message: `Could not disconnect Bluetooth: ${detail}` }
        : current);
      setRepairingBLESessionId(null);
    }
  };

  const repairBLEOverUSB = (sessionId: string) => {
    setBLERepairDialog((current) => current?.sessionId === sessionId
      ? { ...current, stage: "working", progress: 15, message: "Waiting for USB access..." }
      : current);
    const portPromise = appMgr.requestUSBRobotPort();
    void (async () => {
      try {
        const port = await portPromise;
        const backupPath = await appMgr.repairBluetoothIDERobotOverUSB(sessionId, port, (progress, message) => {
          setBLERepairDialog((current) => current?.sessionId === sessionId
            ? { ...current, progress, message }
            : current);
        });
        setBluetoothReadyAfterRepair((current) => ({ ...current, [sessionId]: true }));
        setBLERepairDialog((current) => current?.sessionId === sessionId
          ? { ...current, stage: "complete", progress: 100, message: "Connection restored", backupPath }
          : current);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          setBLERepairDialog((current) => current?.sessionId === sessionId
            ? { ...current, stage: "ready", progress: 10, message: "USB selection was canceled. Select this XRP to continue." }
            : current);
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        setBLERepairDialog((current) => current?.sessionId === sessionId
          ? { ...current, stage: "error", message: detail }
          : current);
      }
    })();
  };

  const connectRepairedBluetooth = (sessionId: string, alias: string) => {
    setBLERepairDialog(null);
    setRepairingBLESessionId(null);
    setStatus(`Select ${alias} in the Bluetooth device chooser...`);
    void appMgr.reconnectBluetoothIDERobotWithChooser(sessionId).then(() => {
      setBluetoothReadyAfterRepair((current) => ({ ...current, [sessionId]: false }));
      setStatus(`${alias} connected over Bluetooth.`);
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  };

  const openRobotTerminal = (sessionId: string, alias: string) => {
    const alreadyOpen = [..._rawWidgetMetaMap.value.values()].some((meta) => {
      if (!meta.content) return false;
      try {
        const parsed = JSON.parse(meta.content) as {
          name?: string;
          props?: { sessionId?: string };
        };
        return parsed.name === "XRPTerminalWidget" && parsed.props?.sessionId === sessionId;
      } catch {
        return false;
      }
    });

    if (alreadyOpen) {
      setStatus(`${alias} terminal is already open.`);
      return;
    }

    addWidget(() => ({
      h: 7,
      w: 4,
      x: 8,
      y: 2,
      minW: 3,
      minH: 5,
      content: JSON.stringify({
        name: "XRPTerminalWidget",
        props: { sessionId, alias },
      }),
    }));
    setStatus(`Opened terminal for ${alias}.`);
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

  const updatePreferredProgram = (sessionId: string, path: string) => {
    setPreferredPrograms((current) => {
      const next = { ...current };
      if (path) next[sessionId] = path;
      else delete next[sessionId];
      writePreferredPrograms(next);
      return next;
    });
  };

  const updatePreferredFolder = (sessionId: string, folder: string) => {
    setPreferredFolders((current) => {
      const next = { ...current, [sessionId]: folder };
      writePreferredFolders(next);
      return next;
    });
    setPreferredPrograms((current) => {
      const selected = current[sessionId];
      if (!selected || getProgramFolder(selected) === folder) return current;
      const next = { ...current };
      delete next[sessionId];
      writePreferredPrograms(next);
      return next;
    });
  };

  const runPreferredProgram = async (
    sessionId: string,
    alias: string,
    programFiles: string[],
  ) => {
    const selected = preferredPrograms[sessionId];

    if (!selected || !programFiles.includes(selected)) {
      setStatus(`Choose a preferred Python or Blockly file for ${alias}.`);
      return;
    }

    const request: PreferredRobotProgramRequest = {
      sessionId,
      path: selected,
    };

    await run(
      () => appMgr.runPreferredProgramsOnRobots([request]),
      `Started preferred program on ${alias}.`,
    );
  };

  const runPreferredPrograms = async () => {
    const missing = connectedIDERobots.filter((robot) => {
      const selected = preferredPrograms[robot.sessionId];
      return !selected || !robot.programFiles.includes(selected);
    });
    if (connectedIDERobots.length === 0) {
      setStatus("Connect at least one XRP before running preferred programs.");
      return;
    }
    if (missing.length > 0) {
      setStatus(`Choose a preferred Python or Blockly file for ${missing.map((robot) => robot.alias).join(", ")}.`);
      return;
    }
    const requests: PreferredRobotProgramRequest[] = connectedIDERobots.map((robot) => ({
      sessionId: robot.sessionId,
      path: preferredPrograms[robot.sessionId],
    }));
    await run(
      () => appMgr.runPreferredProgramsOnRobots(requests),
      `Started preferred programs on ${requests.length} XRP${requests.length === 1 ? "" : "s"}.`,
    );
  };

  const canRunPreferredPrograms = connectedIDERobots.length > 0 && connectedIDERobots.every((robot) => {
    const selected = preferredPrograms[robot.sessionId];
    return Boolean(selected) && robot.programFiles.includes(selected) && robot.runtimeState === "idle";
  });

  const content = (
    <section className="flex h-full w-full flex-col gap-3 overflow-auto rounded-xl bg-black p-3 pt-1 text-xs text-white">
      <div className="rounded-xl border border-purple-500/70 bg-purple-950/20 p-3 shadow-[0_0_22px_rgba(168,85,247,0.12)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <h2 className="text-base font-bold">Program All XRPs at Once</h2>
          </div>
          <button
            type="button"
            aria-pressed={runChoiceEnabled}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 font-bold transition ${
              runChoiceEnabled
                ? "border-green-300 bg-green-700 text-white hover:bg-green-600"
                : "border-zinc-500 bg-black text-zinc-200 hover:border-white hover:text-white"
            }`}
            onClick={() => appMgr.setMultiRobotRunChoiceEnabled(!runChoiceEnabled)}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${runChoiceEnabled ? "bg-green-300" : "bg-zinc-500"}`} />
            {runChoiceEnabled ? "On" : "Off"}
          </button>
        </div>
        {connectedIDERobots.length < 2 && <p className="mt-2 text-xs text-yellow-300">Connect at least two robots in the USB or Bluetooth IDE fleet.</p>}
        <div className="mt-3 border-t border-purple-400/60 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold text-purple-100">Preferred programs</h3>
            <button
              className="rounded-lg border border-purple-300 bg-black px-3 py-2 font-bold text-white transition hover:bg-purple-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canRunPreferredPrograms}
              onClick={() => void runPreferredPrograms()}
            >
              Run preferred programs
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {connectedIDERobots.map((robot) => {
              const selected = preferredPrograms[robot.sessionId];
              const selectedProgram = selected && robot.programFiles.includes(selected) ? selected : "";
              const folders = getProgramFolders(robot.programFiles);
              const storedFolder = preferredFolders[robot.sessionId];
              const inferredFolder = selectedProgram ? getProgramFolder(selectedProgram) : "/";
              const folder = storedFolder && folders.includes(storedFolder) ? storedFolder : inferredFolder;
              const filesInFolder = robot.programFiles.filter((path) => getProgramFolder(path) === folder);
              const value = selectedProgram && filesInFolder.includes(selectedProgram) ? selectedProgram : "";
              return (
                <div key={robot.sessionId} className="grid gap-2 rounded-lg border border-purple-400/30 bg-purple-950/10 p-2 text-xs text-gray-200">
                  <span className="flex items-center gap-2">
                    <RuntimeDot state={robot.runtimeState} />
                    <strong>{robot.alias}</strong>
                  </span>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-gray-400">Folder</span>
                    <select
                      className="w-full rounded border border-purple-300 bg-black p-2 text-white disabled:opacity-50"
                      value={folder}
                      disabled={robot.programFiles.length === 0 || robot.runtimeState !== "idle"}
                      onChange={(event) => updatePreferredFolder(robot.sessionId, event.target.value)}
                    >
                      {folders.map((path) => (
                        <option key={path} value={path}>{path}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-gray-400">Program</span>
                    <div className="flex gap-2">
                      <select
                        className="min-w-0 flex-1 rounded border border-purple-300 bg-black p-2 text-white disabled:opacity-50"
                        value={value}
                        disabled={filesInFolder.length === 0 || robot.runtimeState !== "idle"}
                        onChange={(event) => updatePreferredProgram(robot.sessionId, event.target.value)}
                      >
                        <option value="">
                          {robot.programFiles.length === 0
                            ? "No Python or Blockly files found"
                            : filesInFolder.length === 0
                              ? "No programs in this folder"
                              : "Select program"}
                        </option>
                        {filesInFolder.map((path) => (
                          <option key={path} value={path}>{getProgramName(path)}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="shrink-0 rounded-lg border border-green-300 bg-black px-3 py-2 font-bold text-green-100 transition hover:bg-green-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!value || robot.runtimeState !== "idle"}
                        onClick={() => void runPreferredProgram(robot.sessionId, robot.alias, robot.programFiles)}
                      >
                        Run
                      </button>
                    </div>
                  </label>
                </div>
              );
            })}
            {connectedIDERobots.length === 0 && (
              <p className="text-xs text-yellow-300">Connect an XRP in the USB or Bluetooth IDE fleet.</p>
            )}
          </div>
        </div>
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
                {session.state === "connected" && <button className="rounded-lg border border-emerald-300 px-2 py-1 text-emerald-100 transition hover:bg-emerald-500 hover:text-black" onClick={() => openRobotTerminal(session.sessionId, session.alias)}>Open terminal</button>}
                {session.state === "connected" && <button className={`rounded-lg border px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-50 ${session.bluetoothContextPreloaded ? "border-green-300 bg-green-500 text-black hover:bg-green-400" : "border-cyan-300 text-cyan-100 hover:bg-cyan-500 hover:text-black"}`} disabled={session.runtimeState !== "idle" || preparingBluetoothSessionId !== null} onClick={() => void prepareUSBForBluetooth(session.sessionId, session.alias)}>{preparingBluetoothSessionId === session.sessionId ? "Preparing..." : session.bluetoothContextPreloaded ? "Prepared for Bluetooth" : "Prepare for Bluetooth"}</button>}
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
              {session.bluetoothContextPreloaded && <p className="mt-2 text-xs font-semibold text-green-400">Context preloaded</p>}
              {session.error && <p className="mt-2 text-xs text-red-300">{session.error}</p>}
              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                {session.state === "connected" && <button className="rounded-lg border px-2 py-1 disabled:opacity-50" disabled={session.active} onClick={() => void run(() => appMgr.selectBluetoothIDERobot(session.sessionId), `${session.alias} now owns the IDE files, terminal, save, and run controls.`)}>{session.active ? "IDE files active" : "Open this XRP in IDE"}</button>}
                {session.state === "connected" && <button className="rounded-lg border border-emerald-300 px-2 py-1 text-emerald-100 transition hover:bg-emerald-500 hover:text-black" onClick={() => openRobotTerminal(session.sessionId, session.alias)}>Open terminal</button>}
                {(session.state === "disconnected" || session.state === "error" || stalledBLESessions.includes(session.sessionId)) && !bluetoothReadyAfterRepair[session.sessionId] && <button className="rounded-lg border border-cyan-300 px-2 py-1 text-cyan-100 disabled:opacity-50" disabled={repairingBLESessionId !== null || !usbSnapshot.supported} onClick={() => void openBLERepair(session.sessionId, session.alias)}>{repairingBLESessionId === session.sessionId ? "Repairing..." : "Repair connection"}</button>}
                {bluetoothReadyAfterRepair[session.sessionId] && session.state !== "connected" && <button className="rounded-lg border border-green-300 px-2 py-1 text-green-100" onClick={() => connectRepairedBluetooth(session.sessionId, session.alias)}>Connect by Bluetooth</button>}
                {session.state !== "disconnected" && <button className="rounded-lg border px-2 py-1" onClick={() => void run(() => appMgr.disconnectBluetoothIDERobot(session.sessionId), `${session.alias} disconnected.`)}>Disconnect</button>}
                <button className="rounded-lg border px-2 py-1" onClick={() => { const alias = window.prompt("Robot alias", session.alias); if (alias) { try { appMgr.renameBluetoothIDERobot(session.sessionId, alias); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } } }}>Rename</button>
                <button className="rounded-lg border border-red-400 px-2 py-1 text-red-300" onClick={() => void run(() => appMgr.removeBluetoothIDERobot(session.sessionId), `${session.alias} removed.`)}>Remove</button>
              </div>
            </article>
          ))}
          </div>
        </div>
      </div>

      {bleRepairDialog && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" role="presentation">
        <div role="dialog" aria-modal="true" aria-labelledby="ble-repair-title" className="w-full max-w-md rounded border border-cyan-300 bg-zinc-950 p-5 text-white shadow-2xl" onKeyDown={(event) => { if (event.key === "Escape" && (bleRepairDialog.stage === "ready" || bleRepairDialog.stage === "error")) { setBLERepairDialog(null); setRepairingBLESessionId(null); } }}>
          <h3 id="ble-repair-title" className="text-base font-semibold">Repair Bluetooth connection</h3>
          <p className="mt-3 text-sm text-zinc-200">Connection repair will access {bleRepairDialog.alias} over USB, run a clean program, and disable autorun safely. Select the same XRP in the USB port chooser. Its USB cable can stay connected for power.</p>
          <p className={`mt-4 text-sm ${bleRepairDialog.stage === "error" ? "text-red-300" : bleRepairDialog.stage === "complete" ? "text-green-300" : "text-zinc-200"}`} role="status">{bleRepairDialog.message}</p>
          <div className="mt-3 h-2 overflow-hidden rounded bg-zinc-700" role="progressbar" aria-valuenow={bleRepairDialog.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Connection repair progress"><div className="h-full bg-cyan-400 transition-all duration-300" style={{ width: `${bleRepairDialog.progress}%` }} /></div>
          {bleRepairDialog.backupPath && <p className="mt-3 break-all text-xs text-zinc-400">Previous /main.py backed up to {bleRepairDialog.backupPath}.</p>}
          <div className="mt-5 flex justify-end gap-2 text-sm">
            {(bleRepairDialog.stage === "ready" || bleRepairDialog.stage === "error") && <button type="button" className="rounded border border-zinc-500 px-3 py-2 text-zinc-100 hover:bg-zinc-800" onClick={() => { setBLERepairDialog(null); setRepairingBLESessionId(null); }}>Cancel</button>}
            {bleRepairDialog.stage === "ready" && <button type="button" autoFocus className="rounded border border-cyan-300 bg-cyan-600 px-3 py-2 font-semibold text-white hover:bg-cyan-500" onClick={() => repairBLEOverUSB(bleRepairDialog.sessionId)}>Access USB</button>}
            {bleRepairDialog.stage === "complete" && <button type="button" autoFocus className="rounded border border-green-300 bg-green-600 px-3 py-2 font-semibold text-white hover:bg-green-500" onClick={() => connectRepairedBluetooth(bleRepairDialog.sessionId, bleRepairDialog.alias)}>Exit</button>}
          </div>
        </div>
      </div>, document.body)}

      {status !== INITIAL_STATUS && <p className="rounded-xl border border-zinc-700 bg-zinc-950 p-2 text-zinc-300">{status}</p>}

      <TeamMessageLog snapshot={snapshot} fleet={fleet} />
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
