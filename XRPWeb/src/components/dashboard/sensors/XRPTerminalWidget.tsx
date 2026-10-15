import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { useXTerm } from "react-xtermjs";
import { FaEraser, FaTerminal, FaTrash } from "react-icons/fa";
import type { IDisposable } from "@xterm/xterm";
import AppMgr, { EventType, Themes } from "@/managers/appmgr";
import { useGridStackWidget } from "../hooks/useGridStackWidget";
import SensorCard from "./SensorCard";

interface XRPTerminalWidgetProps {
  sessionId: string;
  alias: string;
}

const appMgr = AppMgr.getInstance();
const DEFAULT_MICROPYTHON_PROMPT = "MicroPython\r\n>>> ";

function extractMicroPythonPrompt(buffer: string): string {
  const matches = [...buffer.matchAll(/MicroPython[\s\S]*?>>> ?/g)];
  const lastMatch = matches.at(-1);
  return lastMatch?.[0] ?? DEFAULT_MICROPYTHON_PROMPT;
}

export default function XRPTerminalWidget({
  sessionId,
  alias,
}: XRPTerminalWidgetProps) {
  const { handleDelete } = useGridStackWidget();
  const { instance, ref } = useXTerm();
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const inputListenerRef = useRef<IDisposable | null>(null);
  const [displayAlias, setDisplayAlias] = useState(alias);
  const [isConnected, setIsConnected] = useState(() => {
    const session = [
      ...appMgr.getUSBFleetSnapshot().sessions,
      ...appMgr.getBluetoothIDEFleetSnapshot().sessions,
    ].find((candidate) => candidate.sessionId === sessionId);
    return session?.state === "connected";
  });

  useEffect(() => {
    const syncRobotSession = () => {
      const session = [
        ...appMgr.getUSBFleetSnapshot().sessions,
        ...appMgr.getBluetoothIDEFleetSnapshot().sessions,
      ].find((candidate) => candidate.sessionId === sessionId);

      if (session) setDisplayAlias(session.alias);
      setIsConnected(session?.state === "connected");
    };
    const handleFleetChange = () => syncRobotSession();

    appMgr.on(EventType.EVENT_USB_FLEET, handleFleetChange);
    appMgr.on(EventType.EVENT_BLE_IDE_FLEET, handleFleetChange);
    syncRobotSession();

    return () => {
      appMgr.eventOff(EventType.EVENT_USB_FLEET, handleFleetChange);
      appMgr.eventOff(EventType.EVENT_BLE_IDE_FLEET, handleFleetChange);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!instance) return;

    const fitAddon = new FitAddon();
    const darkTheme = {
      foreground: "#ddd",
      background: "#333333",
      cursor: "#ddd",
    };
    const lightTheme = {
      foreground: "#41393b",
      background: "#f0eff0",
      cursor: "#41393b",
    };

    instance.loadAddon(fitAddon);
    instance.options = {
      cursorStyle: "underline",
      cursorInactiveStyle: "bar",
      scrollback: 2048,
      disableStdin: false,
      logLevel: "info",
      theme: appMgr.getTheme() === Themes.DARK ? darkTheme : lightTheme,
    };

    const handleTheme = (theme: string) => {
      instance.options.theme = theme === Themes.DARK ? darkTheme : lightTheme;
    };

    const writeTerminal = (data: string) => {
      instance.write(data);
    };

    const bufferedOutput = appMgr.getRobotTerminalBuffer(sessionId);
    if (bufferedOutput) instance.write(bufferedOutput);

    let unsubscribeTerminal: (() => void) | undefined;
    try {
      unsubscribeTerminal = appMgr.subscribeRobotTerminal(sessionId, writeTerminal);
    } catch {
      instance.writeln(`\r\nTerminal session ${sessionId} is not available.`);
    }

    inputListenerRef.current = instance.onData((data) => {
      try {
        appMgr.writeRobotTerminalData(sessionId, data);
      } catch {
        // The session may have been removed while the terminal widget is still open.
      }
    });

    appMgr.on(EventType.EVENT_THEME, handleTheme);

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore transient GridStack resize states.
      }
    };

    const resizeObserver = new ResizeObserver(fit);
    if (terminalHostRef.current) resizeObserver.observe(terminalHostRef.current);

    const handleResize = () => fit();
    window.addEventListener("resize", handleResize);

    requestAnimationFrame(fit);

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      appMgr.eventOff(EventType.EVENT_THEME, handleTheme);
      unsubscribeTerminal?.();
      inputListenerRef.current?.dispose();
      inputListenerRef.current = null;
      fitAddon.dispose();
    };
  }, [instance, sessionId]);

  const handleClearTerminal = () => {
    if (!instance) return;
    const defaultPrompt = extractMicroPythonPrompt(appMgr.getRobotTerminalBuffer(sessionId));
    appMgr.setRobotTerminalBuffer(sessionId, defaultPrompt);
    instance.clear();
    instance.write(defaultPrompt);
  };

  return (
    <SensorCard
      title={`Terminal — ${displayAlias}`}
      icon={<FaTerminal />}
      onStart={() => {}}
      onStop={() => {}}
      isConnected={isConnected}
    >
      <div className="relative h-full w-full overflow-hidden">
        <div className="absolute right-2 top-2 z-10 flex flex-col gap-2">
          <button
            type="button"
            onClick={handleDelete}
            className="rounded border border-red-400 bg-black/80 p-2 text-red-300 transition hover:bg-red-500 hover:text-white"
            title="Close terminal widget"
          >
            <FaTrash size={12} />
          </button>
          <button
            type="button"
            onClick={handleClearTerminal}
            className="rounded border border-emerald-300 bg-black/80 p-2 text-emerald-200 transition hover:bg-emerald-500 hover:text-black"
            title="Clear terminal messages"
          >
            <FaEraser size={12} />
          </button>
        </div>

        <div ref={terminalHostRef} className="h-full w-full overflow-hidden rounded">
          <div ref={ref} className="h-full w-full" />
        </div>

        {!isConnected && (
          <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[10px] text-yellow-200">
            XRP disconnected
          </div>
        )}
      </div>
    </SensorCard>
  );
}
