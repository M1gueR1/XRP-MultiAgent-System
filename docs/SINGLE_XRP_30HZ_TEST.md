# Single-XRP sustained reception experiment at 5, 10 and 30 Hz

## Revision 6 upload correction

The first revision-6 example accidentally contained the firmware's literal BLE
restart marker in a comment at byte/character offset approximately 5150 of 15486
(33.3% of the source). The XRP BLE UART handler scans incoming bytes for this
marker before Python sees them; comments do not escape it. Saving the source over
BLE could therefore reset the board mid-transfer and leave a partial file. This
was a source/upload collision, not evidence of a reader throughput failure.

The example's comment now describes the marker without including it. The IDE
checks single-file and batch file payloads and paths for the reserved sequence
before creating directories or opening a remote file on BLE. Batch checks also
cover matches crossing file boundaries. USB uploads are unaffected; intentional
Stop commands are unaffected. Unsafe uploads fail with an explicit error instead
of sending the bytes. The receiver's revision stays 6 because its runtime read
algorithm did not change.

Reload the updated IDE and replace the **whole** receiver file with the corrected
repository example. If using USB to upload, save/upload it without Run, disconnect
the IDE's USB session, then connect via BLE and Run the corrected file there.
The physical USB cable can remain connected for power. Replace the robot copy,
not just the local editor text, because the interrupted upload may have truncated
the file. No firmware/library update or connection repair is required by this fix.

Run normally adds a three-line robot identity header. That header is expected;
the scoped program builder removes only a matching old identity header and
preserves the following source. Actual missing program lines are a separate
symptom to verify after replacing the partial file; do not infer that every
visible header change means source corruption.

## Next physical diagnostic session (receiver revision 6)

The 10 Hz trial received 542/600 planned samples, with all 542 completed writes
received within the window. The 30 Hz trial received 170 within the window and
25 after it; 34 completed writes remained unconfirmed at the frozen close. The
second trial spent 57.45 s inside byte reads during an approximately 75 s
instrumented lifetime. This points to a receive-path wait/cost to isolate, not
proof that the radio or Python packet decoder cannot sustain 30 Hz.

Revision 6 opts this example into **buffered reads from the existing BLE UART**.
It obtains the active terminal with `os.dupterm(None, 0)` and immediately restores
that same stream in a finally block, before inspecting it. The stream must be a
`BLEUARTStream` with a `BLEUART`, bytearray `_rx_buffer`, `any()` and `read()`.
Otherwise it fails explicitly; it never imports the BLE initializer, creates a
second BLE instance, replaces callbacks, changes firmware files or leaves the
terminal detached. The check matches the interface of the user's previously
inspected 1.25 XRP BLE implementation, not every possible firmware revision.

During the experiment, the input path does not call stdin/select. It reads only
bytes reported already available by that UART, at most **32 bytes per call**.
It keeps the same four-call poll budget, 5 ms loop sleep, ASCII/XPP sample framing,
normal node decoder, TTL/ACK/identity checks, heartbeats and stdout writer. Raw
Ctrl+C raises KeyboardInterrupt. The existing firmware continues to handle its
`##XRPSTOP##` reset token. The bounded five-minute runtime remains. Ordinary
MultiAgentLib programs are unchanged. Do not edit the firmware BLE files.

Replace only `ble_30hz_receiver.py` and reload the updated IDE. Wait for:

```text
RATE_TEST_READY: 1
RATE_TEST_REVISION: 6; bounded buffered BLE experiment
RATE_TEST_READER: ble-uart-buffered-32
```

The assigned robot ID may differ. Start a fresh Windows helper, confirm three
15 ms observations, then run **10 Hz for 60 seconds**, exporting both JSONs.
For a subsequent **30 Hz** trial, rerun the receiver and Windows helper so both
windows are fresh. Keep without-response/20-byte chunks and all other settings.
Let the helper finish normally. If startup fails, share the complete error;
do not repair/flash firmware just to make this experiment run.

To reproduce the old input route, set `USE_BUFFERED_BLE_READER = False` at the
top of the example and Run; its label becomes `stdin-bytewise`. There is no
silent fallback, and returning to normal programs requires no firmware rollback.
On a firmware exposing native DATA the label is `ble-data`, not buffered UART;
that is a different comparison and should be identified explicitly.

Every revision-6 report appends two metadata bytes (revision 6, reader ID 0/1/2).
Progress reports are **37** application bytes, final reports with diagnostics
are **89**. Legacy 35/87-byte reports remain accepted. This adds four ASCII
bytes to each periodic report, not to sample frames. The JSON records
`receiverRevision` and `readerMode` alongside counters, even during partial runs.
In buffered mode `readCalls` counts batch calls; compare `readUs / streamBytes`
and loop/gap maxima rather than comparing mean duration per call with bytewise
reads. No speedup is claimed before physical results arrive.

Source review: upstream RP2 v1.25 `mp_hal_stdin_rx_chr` polls USB and retrieves
one dupterm character at a time; `mp_os_dupterm_rx_chr` asks the stream for one
byte. The installed preview may differ, so the experiment verifies the existing
Python UART interface at runtime instead of asserting binary/source equivalence.

- https://github.com/micropython/micropython/blob/v1.25.0/ports/rp2/mphalport.c
- https://github.com/micropython/micropython/blob/v1.25.0/extmod/os_dupterm.c

## Previous revision-5 diagnostic session

Use one XRP-724e7. Update only `XRPExamples/ble_30hz_receiver.py` on the
robot if its `MultiAgentLib/transport.py` already supports the revision-3 read
budget. No native C module or firmware update is required for this session.
The startup line must say `RATE_TEST_REVISION: 5`.

Run **two separate 60-second trials**, first **5 Hz** (300 planned slots), then
**10 Hz** (600 planned slots), using the new **Requested rate** selector in the
existing **30 Hz test** dialog. Do not start with 30 Hz. Keep UART writes without
response checked, 20-byte chunks, automatic pings paused by the test, and the
Windows interval helper observing 15 ms throughout each sending window.

For each trial: run the receiver file, wait for READY, start the Windows
`run-xrp-ble-rtt.cmd` helper, confirm `YES XRP` where applicable, wait for three
15 ms observations, then confirm the dialog checkbox and start. After finishing,
download `xrp-5hz-<run-id>.json` or `xrp-10hz-<run-id>.json` and retain the Windows
REPORT JSON. Let the helper finish normally, then rerun the receiver and helper
for the next trial. This gives each trial a fresh program and a full 180-second
profile request. Keep the IDE tab visible and the robot stationary.

### What the additional diagnostics mean

Revision 5 appends **13 uint32 values (52 bytes)** only to final REPORT payloads;
ordinary progress reports stay 35 bytes. Final reports are 87 application bytes
and are repeated with identical frozen values. The existing protocol version and
ordinary 35-byte report decoder remain supported. An older receiver running at
30 Hz can finish without diagnostics; the UI explicitly says `Not received`.

`receiver.diagnostics` in the exported JSON includes:

| Field | Meaning |
| --- | --- |
| streamBytes / readCalls | Bytes returned by the REPL stream reader and calls to `read(1)` |
| readUs | Cumulative wall time inside stream reads, including any blocking |
| decodedFrames / decodeUs | All transport frames accepted into the input queue and cumulative ASCII frame reconstruction time |
| transportUs | Cumulative time in transport `read_available`, including polling, reading and reconstruction |
| nodePollCalls / nodePollUs / nodePollMaxUs | Number, total duration and maximum duration of node polls |
| loopGapMaxUs | Largest interval between starts of successive main-loop iterations, including sleep and reporting |
| droppedChunks | Input queue evictions visible to this wrapper |
| handlerUs | Cumulative time handling benchmark application messages |
| writeUs | Cumulative time in the transport writer, including heartbeat/progress writes |

Durations use robot-clock microseconds and wrap-safe `ticks_diff`. Counters reset
at accepted START and freeze at finalization, so they include arming and drain,
not exclusively the nominal 60-second receive window. The poll containing START
can straddle reset. Frames/bytes include control and heartbeat traffic, not only
samples; on native BLE DATA `streamBytes`/`readCalls` remain zero because that
path does not use stdin. `droppedChunks` cannot observe upstream OS, firmware or
radio buffer losses. Stages are nested and **must not be summed**. These are
instrumented wall times, not CPU-exclusive costs, RTT or one-way latency.
Clock reads and counters add measurement overhead; compare the two new trials
with each other before drawing conclusions from older uninstrumented results.

If reads dominate, investigate the REPL stream path; if reconstruction dominates,
investigate framing/parsing; if neither dominates but counts lag, investigate
upstream buffering and scheduling. None alone proves a radio or C-language limit.
Success requires examining written versus received, omissions, late arrivals and
arrival gaps, not just the `complete` status.

### Assessment of the professor's supplied document

Reviewed `RaspberryPiPico2_Bluetooth30Hz_Post.docx` supplied by the user. Its
most applicable recommendations are to instrument actual reception, consume input
regularly, use bounded buffering/flow control and inspect the connection interval.
This implementation already uses sequence counters, bounded input reads and an
unreported-sample guard; it serializes a 32-byte binary sample as 75 UART ASCII
bytes. The new measurements target the remaining receive path without changing
framing, IRQ handlers or adding per-sample acknowledgements.

Treat the document's statement that the board should easily handle 30 Hz as a
hypothesis, not measured evidence for this XRP firmware and browser path. A
stop-and-wait ACK for every sample would change the experiment and serialize it
around RTT, so it is not added here. Binary GATT transport or a producer/consumer
ring remains an option after locating the bottleneck; the document's C snippets
are conceptual examples, not code compatible with the present MicroPython REPL.
The Pico model/radio distinction also matters: Raspberry Pi documents wireless
Pico models separately from non-wireless models:
https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html
MicroPython documents GATT buffers and callbacks here (availability must be
checked against the installed firmware):
https://docs.micropython.org/en/latest/library/bluetooth.html

This is a finite **synthetic load test**, not motor control, a C backend test,
one-way latency measurement, or proof of two-robot RoboCup performance. It uses
the same fleet session, framing, scheduler and Bluetooth transport as normal
messages. No firmware changes or external dependencies are introduced.

## Prepare and run

1. Connect only **XRP-724e7** through Bluetooth. USB is for power, not an active
   IDE data connection. Keep the robot still and the other XRP disconnected.
2. Upload `XRP_MicroPython/XRPExamples/ble_30hz_receiver.py` to the robot root,
   open it and choose **Run in this XRP**. For revision 3, also update only
   `MultiAgentLib/transport.py` at `/lib/MultiAgentLib/transport.py` before Run;
   it adds an optional inner stream-read budget with the old 512-byte default.
   No other library files, C binary or firmware need uploading. Preserve the
   existing 5 ms BLE output patch. Back up any important autorun program before
   IDE Run replaces `main.py`, using the existing Boot Safety tools if needed.
3. Wait for **RATE_TEST_READY** in its terminal. The program gives five minutes
   to start/complete the experiment, then returns. Also check **RATE_TEST_REVISION:
   6** and **RATE_TEST_READER: ble-uart-buffered-32** for the buffered experiment.
   Upgrading an already prepared revision-3 robot only requires replacing the
   example, not uploading `transport.py` again.
   It never imports motor APIs.
4. On Windows, open **tools/windows-bluetooth/run-xrp-ble-rtt.cmd**, not the
   original 30-second interval-only launcher. Confirm **YES XRP** for MPY BTSTACK.
   Wait for three consecutive **DURING interval=15 ms**, connected=True,
   request=Success readings. Keep this helper running for the entire test.
5. In the dashboard, **Multi-agent lab > Team Message Log > 30 Hz test**, check
   choose **Requested rate** (10 Hz for the first buffered trial), and check
   **15 ms confirmed in Windows**. Keep **Use UART writes without response**
   checked if available; otherwise record that it was unavailable. Automatic
   pings are paused. Without-response UART chunks are fixed at 20 bytes; when
   unavailable/unchecked the transport keeps its default write policy instead.
   The checkbox records operator confirmation, not a native interval reading.
6. Click **Start 60-second test**. Do not use the ordinary RTT diagnostic, Run,
   uploads, Repair, other benchmark/movement controls, or another browser tab
   during the test. The browser must stay foreground. The Windows helper stays
   open in the background and still holds its request.
7. Wait through **arming**, **sending**, **draining** and **finishing**. Click
   the download icon to export **xrp-<rate>hz-<run-id>.json**, including partial
   results if the test failed. Do not substitute the old manual-ping CSV.
   Sending still lasts exactly the nominal 60 seconds. **Finishing** can wait
   up to 20 seconds for an explicit final receiver snapshot; this does not
   increase the measurement window or count late deliveries as timely.
8. Let the Windows helper finish normally. Share the test JSON and its separate
   **REPORT** JSON so the timestamped sending window can be matched to actual
   interval observations. A checked box alone is not proof of 15 ms.

If the Windows interval changes, the helper ends before sending finishes, or
Bluetooth disconnects, stop and share the partial results instead of calling
them a successful 15 ms test. **Stop test** cancels future browser sends and
restores the temporary UART/automatic-ping settings. On cancellation/failure the
browser makes a bounded, run-scoped CANCEL attempt on the original link, without
reconnecting or queuing behind a hung write. The JSON records whether cancellation
was confirmed; a completed browser write alone is not receiver confirmation.
An abandoned armed reservation with zero samples can be replaced by a new START.
An active measured run cannot be replaced: it returns BUSY explicitly. If CANCEL
was lost, the receiver still expires after the nominal duration plus 15 seconds.
Wait for expiry before retrying a measured run if cancellation was not confirmed.
After the helper ends, stop the robot program and apply **Disable autorun safely**
before a later power cycle/reconnect if this test should not autorun.

## What it measures

- A sample keeps its **150 ms scheduler TTL**. If coordination traffic occupies
  the sender long enough that a sample expires before the transport is called,
  the benchmark records `expired-before-send` and continues the remaining slots.
  `summary.expiredBeforeSend` counts these unsent samples; they are not receiver
  loss, successful writes or transport errors. They are never retried. The JSON
  records `sampleTtlMs`, the rejection time and scheduler queue duration. Generic
  transport failures, expired START/STOP controls and session changes still stop
  the test. The scheduler's priorities, TTL and health checks are unchanged.
  A complete run with expirations or skipped slots has not sustained the target
  rate. This handles the observed 5 Hz trial where HELLO_ACK, HEARTBEAT and
  TEAM_DIRECTORY blocked a sample for about 373 ms and the previous benchmark
  stopped at its first 150 ms deadline miss.

- **300, 600 or 1,800 planned slots**, one every 1000/requestedHz ms on the laptop monotonic clock.
  This is not the earlier sequential PING/PONG test: it never waits for a PONG
  to schedule the next slot and never sends an application ACK per sample.
- Exactly **one benchmark write may be outstanding**. If the prior write has not
  finished, the next slot is recorded as **backpressure**, not appended to a
  growing queue. If browser scheduling misses slots, they are counted as
  **timer-missed** and never replayed as a catch-up burst. Heartbeats, identity
  refresh, error handling and the normal stop mechanism are not removed.
- Browser write completion does not drain the OS/radio/peripheral queue. JSON
  version 2 therefore caps the outstanding sample-progress window at **60**:
  after 60 submitted samples without a receiver frontier advancing, new slots
  are marked **receiver-backpressure** instead of feeding more bytes. The next
  report's greatest observed `lastSequence` releases older entries. This is not
  a claim that all older samples arrived: only final unique counters establish
  received totals. Skipped slots are not replayed. Healthy one-second reports at
  30 Hz normally stay below this two-second-sized bound. The bound is a queue
  guard, not a latency requirement or a guarantee that the receiver sustains 30 Hz.
- The receiver's private transport wrapper limits each `node.poll()` to four
  received chunks before yielding, and opts into at most **32 one-byte stream
  reads per `read_available()` call**. Limiting chunks alone was insufficient:
  each chunk read could still drain up to 512 stream characters before returning.
  The UART decoder, payload handling, queue bounds and writer are unchanged;
  other programs retain the default 512-byte read budget. Both bounds provide
  opportunities to service heartbeats and reports. No Bluetooth IRQ handler or
  radio parameter is patched, and no heartbeat timeout is extended or bypassed.
- Each sample is 12 application bytes: version/op, 32-bit run ID, 16-bit sample
  number and two neutral 16-bit synthetic velocity values. The private topic
  **0x7f30** is not DRIVE_VELOCITY; no sample can actuate a motor. The existing
  20-byte envelope/framing makes **32 binary bytes**, or **75 ASCII UART bytes**
  per sample, before Bluetooth overhead. Report/control traffic is additional.
- The robot counts unique sample numbers in a bounded bitmap, separately tracks
  duplicates, out-of-order/invalid samples and late arrivals, and reports about
  once per second plus a final snapshot. It does not echo every command.
- STOP shares the UART input queue with the samples and can arrive late. The
  receiver auto-finalizes at duration + 15 seconds after arming even if STOP
  was lost. The sender's separate 20-second final-report wait covers that path;
  its old eight-second wait could end before automatic finalization. No extra
  load samples are sent during this wait, and the three-second fleet heartbeat
  check is unchanged. After finalization the receiver sends the identical frozen
  snapshot three more times, one per second, then becomes silent. A first final
  write completing is not proof it reached the browser. Explicit STOP/CANCEL
  queries remain idempotent and do not reset the frozen counts or timing.
- The robot's nominal receive window starts at its **first unique sample** and
  lasts 60 seconds. `withinWindow / 60` is the displayed reception rate over that
  nominal window. `afterWindow` is separate; late deliveries must not inflate it.
  Initial constant transport delay is not measured by this anchored window.
- `p95GapMs` and `maxGapMs` describe the gaps between unique application-level
  arrivals on the robot. They include buffering/polling and possible batching;
  they are not raw air-interface timings. P95 uses nearest-rank and is calculated
  only for the final snapshot. Stored gaps saturate at 65,534 ms; a P95 at that
  limit means at least that duration, while `maxGapMs` retains the full gap.
  Robot and laptop clocks are not synchronised, so
  no timestamp subtraction is reported as one-way latency or command age.
- `written` means browser transport completion, **not confirmed robot receipt**.
  `missingAtReceiver` compares completed writes against unique final receiver
  counters; it is unconfirmed delivery, not a diagnosis of radio packet loss.
  Received-before-write-completion is possible, so inspect raw samples as well.

`complete` only means the finite test obtained its final report. It does not
automatically mean 30 Hz was sustained: inspect skipped slots, reception count,
per-second snapshots, late arrivals, gap distribution and write diagnostics.
Summary reception rates are null for cancelled/error runs. The JSON keeps partial
samples, phases, UTC timestamps, requested versus actual UART diagnostics and
the fact that the browser did not read the interval. A hung OS write is not
cancellable by this test; at most one finite benchmark frame can remain in flight.
Error exports include the failure phase, runtime state, native-transport connection
check, ready-session IDs and heartbeat age where available. A no-longer-ready
runtime is distinguished from a lost/replaced physical link; health checks are
not disabled. Partial reports are copied before return so late OS completions
cannot silently change their sample counts after the summary was calculated.
The export also records `sendFinishedAt` and `finalReportTimeoutMs` separately
from overall finish time. A periodic `receiving` report is never silently promoted
to `final` on timeout; absence of a final report still produces an incomplete run.

## Verification

From `XRPWeb/`:

```powershell
npx vitest run src/multiagent/__tests__/sustainedRate.spec.ts src/components/dashboard/sensors/__tests__/SustainedRateTestPanel.spec.tsx src/components/dashboard/sensors/__tests__/TeamMessageLog.spec.tsx
npm run build
```

From `XRP_MicroPython/`:

```powershell
python -m unittest discover -s tests -p test_ble_rate_receiver.py -v
```

The automated tests exercise fake timing/transports and the receiver's counters.
Only the physical run validates the laptop adapter, XRP firmware and 30 Hz load.
