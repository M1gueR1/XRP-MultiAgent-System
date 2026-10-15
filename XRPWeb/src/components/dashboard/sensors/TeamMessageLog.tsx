import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaChartLine, FaDownload, FaStop, FaTimes, FaTrash } from "react-icons/fa";
import { saveAs } from "file-saver";
import { BROADCAST_ROBOT_ID, runSingleRobotRttTest, type FleetSnapshot, type PingTestResult, type RobotFleetManager, type RuntimeDataChannel } from "@/multiagent";

type TestSample = {
  id: number;
  time: number;
  robotId: number;
  alias: string;
  result?: PingTestResult;
  error?: string;
  seriesId?: number;
  automaticPings?: "on" | "paused";
  uartWithoutResponse?: boolean;
  uartChunkSizeBytes?: 20 | 55;
};

const channelLabel = (channel?: RuntimeDataChannel) => ({
  "ble-data": "BLE DATA", "ble-uart": "BLE UART", usb: "USB", unknown: "Unknown",
})[channel ?? "unknown"];

const milliseconds = (value?: number) => value === undefined ? "-" : value.toFixed(1);

export default function TeamMessageLog({ snapshot, fleet }: { snapshot: FleetSnapshot; fleet: RobotFleetManager }) {
  const [view, setView] = useState<"tests" | "traffic">("tests");
  const [showTester, setShowTester] = useState(false);
  const [target, setTarget] = useState(String(BROADCAST_ROBOT_ID));
  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<TestSample[]>([]);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [sampleCount, setSampleCount] = useState(30);
  const [pauseAutomaticPings, setPauseAutomaticPings] = useState(false);
  const [uartWithoutResponse, setUartWithoutResponse] = useState(false);
  const [uart55ByteWrites, setUart55ByteWrites] = useState(false);
  const [seriesRunning, setSeriesRunning] = useState(false);
  const [seriesId, setSeriesId] = useState(0);
  const [seriesProgress, setSeriesProgress] = useState({ completed: 0, total: 0 });
  const [diagnosticError, setDiagnosticError] = useState("");
  const testController = useRef<AbortController>();
  const nextSeriesId = useRef(1);
  const nextSampleId = useRef(1);
  const ready = snapshot.sessions.filter((session) => session.state === "ready" && session.robotId !== undefined);
  const received = samples.filter((sample) => sample.result?.status === "received").length;
  const singleRobot = ready.length === 1 ? ready[0] : undefined;
  const canDiagnose = singleRobot?.runtimeChannel === "ble-data" || singleRobot?.runtimeChannel === "ble-uart";
  const canUseUartWithoutResponse = singleRobot?.runtimeChannel === "ble-uart" && singleRobot.runtimeUartWithoutResponseSupported === true;
  const seriesSamples = samples.filter((sample) => sample.seriesId === seriesId && seriesId !== 0);
  const sortedRtts = seriesSamples.flatMap((sample) => sample.result?.rttMs === undefined ? [] : [sample.result.rttMs]).sort((a, b) => a - b);
  const mean = sortedRtts.length ? sortedRtts.reduce((sum, value) => sum + value, 0) / sortedRtts.length : undefined;
  const median = sortedRtts.length ? (sortedRtts[Math.floor((sortedRtts.length - 1) / 2)] + sortedRtts[Math.floor(sortedRtts.length / 2)]) / 2 : undefined;
  const p95 = sortedRtts.length ? sortedRtts[Math.ceil(sortedRtts.length * 0.95) - 1] : undefined;

  useEffect(() => () => testController.current?.abort(), []);
  useEffect(() => setUart55ByteWrites(false), [singleRobot?.sessionId]);

  const runDiagnostic = async () => {
    if (running || !singleRobot || !canDiagnose) return;
    const useUartWithoutResponse = uartWithoutResponse && canUseUartWithoutResponse;
    const uartChunkSizeBytes = useUartWithoutResponse && uart55ByteWrites ? 55 : 20;
    if (uartChunkSizeBytes === 55 && !window.confirm(
      `Use 55-byte UART writes on ${singleRobot.alias}? Confirm its current negotiated MTU is at least 58 bytes and its UART RX buffer is at least 55 bytes. Cancel if either value is unknown.`,
    )) return;
    const controller = new AbortController();
    testController.current = controller;
    const currentSeriesId = nextSeriesId.current++;
    setSeriesId(currentSeriesId);
    setSeriesProgress({ completed: 0, total: sampleCount });
    setDiagnosticError("");
    setShowDiagnostic(false);
    setView("tests");
    setRunning(true);
    setSeriesRunning(true);
    try {
      await runSingleRobotRttTest(fleet, {
        robotId: singleRobot.robotId!, count: sampleCount, pauseAutomaticPings,
        uartWithoutResponse: useUartWithoutResponse, uartChunkSizeBytes, signal: controller.signal,
        onResult: (result) => {
          const sample: TestSample = {
            id: nextSampleId.current++, time: result.startedAt, robotId: result.robotId,
            alias: singleRobot.alias, result, seriesId: currentSeriesId,
            automaticPings: pauseAutomaticPings ? "paused" : "on",
            uartWithoutResponse: useUartWithoutResponse,
            uartChunkSizeBytes: useUartWithoutResponse ? uartChunkSizeBytes : undefined,
          };
          setSamples((current) => [sample, ...current].slice(0, 200));
          setSeriesProgress((current) => ({ ...current, completed: current.completed + 1 }));
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) setDiagnosticError(error instanceof Error ? error.message : String(error));
    } finally {
      if (testController.current === controller) testController.current = undefined;
      setSeriesRunning(false);
      setRunning(false);
    }
  };

  const sendTest = async () => {
    const targets = fleet.getReadySessions().filter((session) => target === String(BROADCAST_ROBOT_ID) || String(session.robotId) === target);
    if (running || targets.length === 0) return;
    const requests = targets.map((session) => ({
      id: nextSampleId.current++, time: Date.now(), robotId: session.robotId!, alias: session.alias,
    }));
    setSamples((current) => [...requests, ...current].slice(0, 200));
    setView("tests");
    setShowTester(false);
    setRunning(true);
    try {
      await Promise.all(requests.map(async (request) => {
        try {
          const result = await fleet.pingForTest(request.robotId);
          setSamples((current) => current.map((sample) => sample.id === request.id ? { ...sample, result } : sample));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setSamples((current) => current.map((sample) => sample.id === request.id ? { ...sample, error: detail } : sample));
        }
      }));
    } finally {
      setRunning(false);
    }
  };

  const exportResults = () => {
    const rows = [["test", "started_at", "robot_id", "robot_name", "ping_sequence", "status", "rtt_ms", "detail",
      "series", "automatic_pings", "transport", "packet_bytes", "encoded_bytes", "scheduler_queue_ms",
      "transport_call_ms", "gatt_queue_ms", "gatt_operation_ms", "gatt_write_chunks", "gatt_write_attempts",
      "gatt_write_retries", "after_write_ms", "reply_before_write_completed", "queue_depth_at_enqueue",
      "diagnostic_version", "automatic_ping_policy", "active_write_at_enqueue", "queued_writes_at_enqueue",
      "pending_acks_at_enqueue", "blocking_writes", "blocking_write_ms", "blocking_message_kinds", "automatic_pings_skipped",
      "write_mode", "uart_without_response_requested", "uart_chunk_size_requested", "gatt_write_chunk_size_bytes"],
      ...[...samples].reverse().map((sample) => [
        sample.id, new Date(sample.time).toISOString(), sample.robotId, sample.alias,
        sample.result?.sequence ?? "", sample.error ? "error" : sample.result?.status ?? "pending",
        sample.result?.rttMs ?? "", sample.error ?? sample.result?.detail ?? "",
        sample.seriesId ?? "", sample.automaticPings ?? "on", sample.result?.diagnostics?.channel ?? "unknown",
        sample.result?.diagnostics?.packetBytes ?? "", sample.result?.diagnostics?.encodedBytes ?? "",
        sample.result?.diagnostics?.schedulerQueueMs ?? "", sample.result?.diagnostics?.transportCallMs ?? "",
        sample.result?.diagnostics?.gattQueueMs ?? "", sample.result?.diagnostics?.gattOperationMs ?? "",
        sample.result?.diagnostics?.chunks ?? "", sample.result?.diagnostics?.attempts ?? "",
        sample.result?.diagnostics?.retries ?? "", sample.result?.afterWriteMs ?? "",
        sample.result?.replyBeforeWriteCompleted ?? "", sample.result?.diagnostics?.queueDepthAtEnqueue ?? "",
        4, sample.automaticPings === "paused" ? "paused" : "idle-after-heartbeat",
        sample.result?.diagnostics?.activeWriteAtEnqueue ?? "", sample.result?.diagnostics?.queuedWritesAtEnqueue ?? "",
        sample.result?.diagnostics?.pendingAcksAtEnqueue ?? "", sample.result?.diagnostics?.blockingWrites ?? "",
        sample.result?.diagnostics?.blockingWriteMs ?? "", sample.result?.diagnostics?.blockingMessageKinds ?? "",
        sample.result?.diagnostics?.automaticPingsSkipped ?? "",
        sample.result?.diagnostics?.writeMode ?? "unknown", sample.uartWithoutResponse ?? false,
        sample.uartChunkSizeBytes ?? "", sample.result?.diagnostics?.chunkSizeBytes ?? "",
      ])];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    saveAs(new Blob([csv], { type: "text/csv;charset=utf-8" }), "xrp-manual-ping-tests.csv");
  };

  return <div className="min-w-0 border-t border-[#fde047]/80 bg-[#000000] pt-3 text-[#ffffff]">
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <h3 className="mr-auto font-semibold text-[#fef9c3]">Team Message Log</h3>
      <button type="button" className="rounded border border-[#fde047] bg-[#000000] px-3 py-1 font-bold text-[#fef9c3] hover:bg-[#fde047] hover:text-[#000000] disabled:opacity-50" disabled={running || ready.length === 0} onClick={() => {
        if (target !== String(BROADCAST_ROBOT_ID) && !ready.some((session) => String(session.robotId) === target)) setTarget(String(BROADCAST_ROBOT_ID));
        setShowTester(true);
      }}>{running ? "Waiting for replies..." : "Test message"}</button>
      <button type="button" disabled={running || ready.length === 0} className="flex items-center gap-2 rounded border border-[#fde047] px-3 py-1 text-[#fef9c3] disabled:opacity-50" onClick={() => setShowDiagnostic(true)}><FaChartLine /> RTT diagnostic</button>
      {seriesRunning && <><span className="text-mountain-mist-300">{seriesProgress.completed}/{seriesProgress.total}</span><button type="button" title="Stop RTT test" aria-label="Stop RTT test" className="rounded border border-cinnabar-300 p-2 text-cinnabar-300" onClick={() => testController.current?.abort()}><FaStop /></button></>}
    </div>
    {diagnosticError && <p role="alert" className="mb-2 break-words text-cinnabar-300">{diagnosticError}</p>}
    {view === "tests" && seriesSamples.length > 0 && <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 border-y border-mountain-mist-700 py-2 text-xs text-mountain-mist-300" aria-label="RTT series summary">
      <span>Series {seriesId}: {seriesSamples[0].alias}</span><span>Automatic pings: {seriesSamples[0].automaticPings}</span>
      <span>Write mode: {seriesSamples[0].result?.diagnostics?.writeMode ?? "unknown"}</span>
      <span>GATT chunk size: {seriesSamples[0].result?.diagnostics?.chunkSizeBytes ?? "unknown"} bytes</span>
      <span>Received: {sortedRtts.length}/{seriesSamples.length}</span><span>Mean: {milliseconds(mean)} ms</span>
      <span>Median: {milliseconds(median)} ms</span><span>P95: {milliseconds(p95)} ms</span>
    </div>}
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="flex overflow-hidden rounded border border-mountain-mist-600" role="tablist" aria-label="Message log view">
        {([['tests', 'Test results'], ['traffic', 'All traffic']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={view === value} className={`px-3 py-1 ${view === value ? "bg-[#fde047] text-[#000000]" : "bg-[#000000] text-mountain-mist-300 hover:bg-mountain-mist-800"}`} onClick={() => setView(value)}>{label}</button>)}
      </div>
      {view === "tests" && <>
        <span className="mr-auto text-mountain-mist-300">{received}/{samples.length} received</span>
        <button type="button" title="Export test results as CSV" aria-label="Export test results as CSV" disabled={running || samples.length === 0} className="rounded border border-mountain-mist-500 p-2 disabled:opacity-40" onClick={exportResults}><FaDownload /></button>
        <button type="button" title="Clear test results" aria-label="Clear test results" disabled={running || samples.length === 0} className="rounded border border-mountain-mist-500 p-2 disabled:opacity-40" onClick={() => setSamples([])}><FaTrash /></button>
      </>}
    </div>
    <div className="max-h-56 overflow-auto" role="tabpanel" aria-label={view === "tests" ? "Test results" : "All traffic"}>
      {view === "tests" ? (samples.length === 0 ? <p className="py-2 text-mountain-mist-400">No manual tests yet.</p> : <table className="w-full min-w-[68rem] text-left text-xs">
        <thead className="text-mountain-mist-400"><tr><th className="py-1 pr-2">Test</th><th className="pr-2">Time</th><th className="pr-2">XRP</th><th className="pr-2">Result</th><th className="pr-2">RTT (ms)</th><th className="pr-2">Transport</th><th className="pr-2" title="Waiting in the message scheduler before calling the transport">Queue (ms)</th><th className="pr-2" title="Waiting for earlier Bluetooth writes">GATT queue (ms)</th><th className="pr-2" title="GATT operation including retries; browser completion is not robot receipt">GATT write (ms)</th><th className="pr-2" title="Time from browser write completion to PONG, including processing and reception; not pure radio latency">After write (ms)</th><th className="pr-2" title="Browser GATT write calls, not radio packets">Chunks</th><th className="pr-2">Retries</th><th className="pr-2" title="Messages whose writes overlapped this probe's scheduler waiting">Blocked by</th><th title="Cumulative automatic probes skipped while busy or awaiting a PONG since this program session started">Auto pings skipped</th></tr></thead>
        <tbody>{samples.map((sample) => {
          const failed = sample.error || sample.result?.status === "error";
          const timedOut = sample.result?.status === "timeout";
          return <tr key={sample.id} className="border-t border-mountain-mist-800">
            <td className="py-2 pr-2">#{sample.id}</td><td className="whitespace-nowrap pr-2">{new Date(sample.time).toLocaleTimeString()}</td>
            <td className="max-w-40 break-words pr-2">{sample.alias} ({sample.robotId})</td>
            <td className={`max-w-48 break-words pr-2 ${failed ? "text-cinnabar-300" : timedOut ? "text-[#fde047]" : sample.result ? "text-chateau-green-300" : "text-mountain-mist-300"}`}>
              {failed ? "Error" : timedOut ? "No response within 5 s" : sample.result ? "Received" : "Waiting..."}
              {failed && <span className="block text-mountain-mist-400">{sample.error ?? sample.result?.detail}</span>}
            </td><td className="whitespace-nowrap pr-2 font-mono">{milliseconds(sample.result?.rttMs)}</td>
            <td className="whitespace-nowrap pr-2">{channelLabel(sample.result?.diagnostics?.channel)}</td>
            <td className="pr-2 font-mono">{milliseconds(sample.result?.diagnostics?.schedulerQueueMs)}</td>
            <td className="pr-2 font-mono">{milliseconds(sample.result?.diagnostics?.gattQueueMs)}</td>
            <td className="pr-2 font-mono">{milliseconds(sample.result?.diagnostics?.gattOperationMs)}</td>
            <td className="pr-2 font-mono">{milliseconds(sample.result?.afterWriteMs)}</td>
            <td className="pr-2">{sample.result?.diagnostics?.chunks ?? "-"}</td><td className="pr-2">{sample.result?.diagnostics?.retries ?? "-"}</td>
            <td className="max-w-48 break-words pr-2">{sample.result?.diagnostics?.blockingMessageKinds || "-"}</td>
            <td>{sample.result?.diagnostics?.automaticPingsSkipped ?? "-"}</td>
          </tr>;
        })}</tbody>
      </table>) : (snapshot.routingLog.length === 0 ? <p className="py-2 text-mountain-mist-400">No messages routed yet.</p> : <table className="w-full min-w-[26rem] text-left font-mono text-xs">
        <thead className="text-mountain-mist-400"><tr><th>Time</th><th>From</th><th>To</th><th>Topic</th><th>Status</th></tr></thead>
        <tbody>{snapshot.routingLog.map((entry) => <tr key={entry.id} className="border-t border-mountain-mist-800"><td className="whitespace-nowrap py-1 pr-2">{new Date(entry.time).toLocaleTimeString()}</td><td className="pr-2">{entry.sourceRobotId}</td><td className="pr-2">{entry.targetRobotId}</td><td className="pr-2">0x{entry.topicId.toString(16).padStart(4, "0")}</td><td>{entry.status}{entry.rttMs !== undefined ? ` ${entry.rttMs.toFixed(1)}ms` : ""}</td></tr>)}</tbody>
      </table>)}
    </div>
    {showTester && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#000000]/70 p-4" onClick={(event) => { if (event.target === event.currentTarget) setShowTester(false); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="manual-ping-title" className="w-full max-w-md rounded border border-[#fde047] bg-[#000000] p-4 text-[#ffffff] shadow-2xl" onKeyDown={(event) => { if (event.key === "Escape") setShowTester(false); }}>
        <div className="mb-3 flex items-center justify-between gap-3"><h3 id="manual-ping-title" className="text-base font-semibold">Send Test Message</h3><button type="button" title="Close" aria-label="Close" className="rounded border border-mountain-mist-500 p-2" onClick={() => setShowTester(false)}><FaTimes /></button></div>
        <label className="block text-sm">Target<select autoFocus className="mt-1 block w-full rounded border border-[#ffffff] bg-[#000000] p-2" value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value={String(BROADCAST_ROBOT_ID)}>All ready XRPs</option>{ready.map((session) => <option key={session.sessionId} value={String(session.robotId)}>{session.alias} ({session.robotId})</option>)}
        </select></label>
        <button type="button" className="mt-4 w-full rounded bg-[#fde047] px-3 py-2 font-semibold text-[#000000] disabled:opacity-50" disabled={running || ready.length === 0} onClick={() => void sendTest()}>Send message</button>
      </div>
    </div>, document.body)}
    {showDiagnostic && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#000000]/70 p-4" onClick={(event) => { if (event.target === event.currentTarget) setShowDiagnostic(false); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="single-rtt-title" className="max-h-[90vh] w-full max-w-md overflow-auto rounded border border-[#fde047] bg-[#000000] p-4 text-[#ffffff] shadow-2xl" onKeyDown={(event) => { if (event.key === "Escape") setShowDiagnostic(false); }}>
        <div className="mb-3 flex items-center justify-between gap-3"><h3 id="single-rtt-title" className="text-base font-semibold">Single-XRP RTT</h3><button autoFocus type="button" title="Close" aria-label="Close" className="rounded border border-mountain-mist-500 p-2" onClick={() => setShowDiagnostic(false)}><FaTimes /></button></div>
        {canDiagnose ? <p className="mb-3 break-words text-[#fef9c3]">{singleRobot!.alias} ({singleRobot!.robotId}) - {channelLabel(singleRobot!.runtimeChannel)}</p> : <p role="alert" className="mb-3 text-cinnabar-300">Exactly one ready Bluetooth XRP is required.</p>}
        <label className="block text-sm">Samples<input type="number" min={1} max={100} step={1} className="mt-1 block w-full rounded border border-[#ffffff] bg-[#000000] p-2" value={sampleCount} onChange={(event) => setSampleCount(Number(event.target.value))} /></label>
        <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={pauseAutomaticPings} onChange={(event) => setPauseAutomaticPings(event.target.checked)} />Pause automatic pings</label>
        {singleRobot?.runtimeChannel === "ble-uart" && <>
          <label className="mt-3 flex items-center gap-2 text-sm" title={canUseUartWithoutResponse ? "Experimental UART runtime write mode" : "Not advertised by the connected XRP"}><input type="checkbox" disabled={!canUseUartWithoutResponse} checked={uartWithoutResponse && canUseUartWithoutResponse} onChange={(event) => {
            setUartWithoutResponse(event.target.checked);
            if (!event.target.checked) setUart55ByteWrites(false);
          }} />Use UART writes without response</label>
          <label className="mt-3 flex items-center gap-2 text-sm" title="Only for a verified MTU of at least 58 bytes and UART RX buffer of at least 55 bytes; larger frames retain 20-byte chunks"><input type="checkbox" disabled={!canUseUartWithoutResponse || !uartWithoutResponse} checked={uart55ByteWrites && uartWithoutResponse && canUseUartWithoutResponse} onChange={(event) => setUart55ByteWrites(event.target.checked)} />Use 55-byte UART writes</label>
        </>}
        <button type="button" className="mt-4 flex w-full items-center justify-center gap-2 rounded bg-[#fde047] px-3 py-2 font-semibold text-[#000000] disabled:opacity-50" disabled={running || !canDiagnose || !Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 100} onClick={() => void runDiagnostic()}><FaChartLine /> Start RTT test</button>
      </div>
    </div>, document.body)}
  </div>;
}
