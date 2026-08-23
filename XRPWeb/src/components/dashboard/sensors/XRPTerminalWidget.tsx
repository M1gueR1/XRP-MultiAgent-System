import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { useXTerm } from "react-xtermjs";
import { FaTerminal, FaTrash } from "react-icons/fa";
import type { IDisposable } from "@xterm/xterm";
import AppMgr, { EventType, Themes } from "@/managers/appmgr";
import type { USBRobotFleetSnapshot } from "@/connections/usbFleetTypes";
import { useGridStackWidget } from "../hooks/useGridStackWidget";
import SensorCard from "./SensorCard";

interface XRPTerminalWidgetProps {
  sessionId: string;
  alias: string;
}

const appMgr = AppMgr.getInstance();

export default function XRPTerminalWidget({
  sessionId,
  alias,
}: XRPTerminalWidgetProps) {
  const { handleDelete } = useGridStackWidget();
  const { instance, ref } = useXTerm();
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const inputListenerRef = useRef<IDisposable | null>(null);
  const [displayAlias, setDisplayAlias] = useState(alias);
  const [isConnected, setIsConnected] = useState(() =>
    appMgr.getUSBFleetSnapshot().sessions.some(
      (session) => session.sessionId === sessionId && session.state === "connected",
    ),
  );

  useEffect(() => {
    const handleUSBFleet = (serialized: string) => {
      try {
        const snapshot = JSON.parse(serialized) as USBRobotFleetSnapshot;
        const session = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (session) {
          setDisplayAlias(session.alias);
          setIsConnected(session.state === "connected");
        } else {
          setIsConnected(false);
        }
      } catch {
        setIsConnected(false);
      }
    };

    appMgr.on(EventType.EVENT_USB_FLEET, handleUSBFleet);
    handleUSBFleet(JSON.stringify(appMgr.getUSBFleetSnapshot()));

    return () => {
      appMgr.eventOff(EventType.EVENT_USB_FLEET, handleUSBFleet);
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

  return (
    <SensorCard
      title={`Terminal — ${displayAlias}`}
      icon={<FaTerminal />}
      onStart={() => {}}
      onStop={() => {}}
      isConnected={isConnected}
    >
      <div className="relative h-full w-full overflow-hidden">
        <div className="absolute right-2 top-2 z-10">
          <button
            type="button"
            onClick={handleDelete}
            className="rounded border border-red-400 bg-black/80 p-2 text-red-300 transition hover:bg-red-500 hover:text-white"
            title="Close terminal widget"
          >
            <FaTrash size={12} />
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