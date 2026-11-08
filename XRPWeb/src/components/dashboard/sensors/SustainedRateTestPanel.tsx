import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaDownload, FaPlay, FaStop, FaTimes, FaTachometerAlt } from "react-icons/fa";
import { saveAs } from "file-saver";
import type { FleetSnapshot, RobotFleetManager } from "@/multiagent";
import { runSustainedRateTest, type SustainedRateResult } from "@/multiagent/benchmark/SustainedRateTest";

export default function SustainedRateTestPanel({ snapshot, fleet, busy, onBusyChange }: {
  snapshot: FleetSnapshot; fleet: RobotFleetManager; busy: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [withoutResponse, setWithoutResponse] = useState(true);
  const [requestedHz, setRequestedHz] = useState(5);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("Idle");
  const [received, setReceived] = useState<number>();
  const [result, setResult] = useState<SustainedRateResult>();
  const [error, setError] = useState("");
  const controller = useRef<AbortController>();
  const ready = snapshot.sessions.filter((robot) => robot.state === "ready");
  const robot = ready.length === 1 ? ready[0] : undefined;
  const bluetooth = robot?.runtimeChannel === "ble-uart" || robot?.runtimeChannel === "ble-data";
  const canUseWithoutResponse = robot?.runtimeChannel === "ble-uart" && robot.runtimeUartWithoutResponseSupported === true;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => setConfirmed(false), [robot?.sessionId]);

  const start = async () => {
    if (!robot || robot.robotId === undefined || busy || !confirmed) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true); onBusyChange(true); setError(""); setResult(undefined); setProgress(0); setReceived(undefined);
    try {
      const report = await runSustainedRateTest(fleet, {
        robotId: robot.robotId, signal: abort.signal, intervalConfirmed: confirmed,
        uartWithoutResponse: withoutResponse && canUseWithoutResponse,
        requestedHz,
        onProgress: (stage, fraction, receiver) => {
          setPhase(stage); setProgress(fraction); setReceived(receiver?.received);
        },
      });
      setResult(report); setPhase(report.status); setReceived(report.receiver?.received);
      setError(report.error ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason)); setPhase("error");
    } finally {
      controller.current = undefined; setRunning(false); onBusyChange(false);
      // A new run requires rechecking the Windows window, not a stale confirmation.
      setConfirmed(false);
    }
  };
  const button = "rounded border border-[#fde047] px-3 py-1 text-[#fef9c3] disabled:opacity-40";
  return <>
    <button type="button" disabled={busy || !bluetooth} className={`flex items-center gap-2 ${button}`} onClick={() => setOpen(true)}><FaTachometerAlt />30 Hz test</button>
    {open && createPortal(<div className="fixed inset-0 z-[110] flex items-center justify-center bg-[#000000]/70 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="rate-test-title" className="max-h-[90vh] w-full max-w-lg overflow-auto rounded border border-[#fde047] bg-[#000000] p-4 text-[#ffffff]" onKeyDown={(event) => { if (event.key === "Escape" && !running) setOpen(false); }}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 id="rate-test-title" className="text-base font-semibold">Single-XRP receive rate test</h3>
          <button type="button" aria-label="Close 30 Hz test" title="Close" disabled={running} className="rounded border border-mountain-mist-500 p-2 disabled:opacity-40" onClick={() => setOpen(false)}><FaTimes /></button>
        </div>
        <p className="mb-4 break-words text-sm text-[#fef9c3]">{robot?.alias ?? "No single XRP"} | {requestedHz} Hz | 60 s | {requestedHz * 60} slots</p>
        <label className="mb-3 flex items-center gap-2 text-sm">Requested rate
          <select aria-label="Requested rate" className="rounded border border-mountain-mist-500 bg-[#000000] p-1 text-[#ffffff]" value={requestedHz} disabled={running} onChange={(event) => { setRequestedHz(Number(event.target.value)); setResult(undefined); setReceived(undefined); setPhase("Idle"); setError(""); }}>
            <option value={5}>5 Hz</option><option value={10}>10 Hz</option><option value={30}>30 Hz</option>
          </select>
        </label>
        <p className="mb-3 text-sm">Use receiver revision 6 for the buffered BLE experiment. Start at 10 Hz. Check RATE_TEST_READER before starting. Diagnostics and the reader path are included in the final JSON.</p>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={running} onChange={(event) => setConfirmed(event.target.checked)} />15 ms confirmed in Windows</label>
        {robot?.runtimeChannel === "ble-uart" && <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={withoutResponse && canUseWithoutResponse} disabled={running || !canUseWithoutResponse} onChange={(event) => setWithoutResponse(event.target.checked)} />Use UART writes without response</label>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-mountain-mist-700 py-3 text-sm">
          <dt>Automatic pings</dt><dd>Paused during test</dd><dt>UART chunks</dt><dd>{withoutResponse && canUseWithoutResponse ? "20 bytes" : "Transport default"}</dd>
          <dt>Phase</dt><dd className="capitalize">{phase}</dd><dt>Receiver count</dt><dd>{received ?? "-"} / {requestedHz * 60}</dd>
          {result && <>
            <dt>Writes completed</dt><dd>{result.summary?.written ?? "-"}</dd>
            <dt>Expired before sending</dt><dd>{result.summary?.expiredBeforeSend ?? "-"}</dd>
            <dt>Skipped: backpressure</dt><dd>{result.summary?.skippedBackpressure ?? "-"}</dd>
            <dt>Skipped: receiver backlog</dt><dd>{result.summary?.skippedReceiverBackpressure ?? "-"}</dd>
            <dt>Skipped: browser timing</dt><dd>{result.summary?.skippedTimer ?? "-"}</dd>
            <dt>Receiver / 60 s</dt><dd>{result.summary?.receiverHzOverScheduledWindow?.toFixed(2) ?? "-"} Hz</dd>
            <dt>Unconfirmed at receiver</dt><dd>{result.summary?.missingAtReceiver ?? "-"}</dd>
            <dt>Arrival gap P95 / max</dt><dd>{result.receiver?.p95GapMs ?? "-"} / {result.receiver?.maxGapMs ?? "-"} ms</dd>
            <dt>Receiver diagnostics</dt><dd>{result.receiver?.diagnostics ? "Included in JSON" : "Not received"}</dd>
            <dt>Reader path</dt><dd className="break-words">{result.receiver?.readerMode ?? "Not reported (older receiver)"}</dd>
          </>}
        </dl>
        {!!result?.summary?.expiredBeforeSend && <p role="status" className="mt-3 text-sm text-[#fef9c3]">Some samples missed their 150 ms queue deadline and were not sent. Completing the test does not mean the requested rate was achieved.</p>}
        <progress aria-label="30 Hz test progress" className="mt-4 h-2 w-full accent-[#fde047]" max={1} value={progress} />
        {error && <p role="alert" className="mt-3 break-words text-cinnabar-300">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          {result && <button type="button" className={button} title="Export 30 Hz JSON" aria-label="Export 30 Hz JSON" onClick={() => saveAs(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), `xrp-${result.requestedHz}hz-${result.runId}.json`)}><FaDownload /></button>}
          {running ? <button type="button" className={`flex items-center gap-2 ${button}`} onClick={() => controller.current?.abort()}><FaStop />Stop test</button>
            : <button type="button" disabled={busy || !confirmed || !bluetooth} className={`flex items-center gap-2 ${button}`} onClick={() => void start()}><FaPlay />Start 60-second test</button>}
        </div>
      </div>
    </div>, document.body)}
  </>;
}
