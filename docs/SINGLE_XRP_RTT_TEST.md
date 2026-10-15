# Single-XRP Bluetooth RTT diagnostic

This first experiment measures laptop -> XRP -> laptop PING/PONG RTT, not
robot-to-robot latency or sustainable 30 Hz command delivery. The packet format,
connection procedure, chunk size and retry policy are unchanged.

## Setup

1. Power one XRP through USB, but do not open a USB connection in the dashboard.
   Disconnect the other XRP from the IDE/fleet for this test.
2. Connect the powered XRP through Bluetooth and close the connection game.
3. Create a Python file in the XRP IDE using the contents of
   `XRP_MicroPython/XRPExamples/rtt_single_robot.py`, then run it on this XRP only.
   The IDE installs/configures MultiAgentLib for the selected connection when
   preparing a team program. Do not stop the program during measurements.
4. Wait for `RTT_READY` and for the robot to be ready in Multi-agent lab. Keep the
   distance fixed (for example 0.5 m), the browser in the foreground, and avoid
   terminal commands, repeated prints, other tests and movement during the run.

## Experiment

1. In Team Message Log, open `RTT diagnostic`. The dialog identifies the selected
   robot and actual browser-side runtime channel: BLE DATA or BLE UART.
2. Keep `Samples` at 30. Leave `Pause automatic pings` unchecked for the baseline.
3. Click `Start RTT test`. Tests are sequential: one outstanding test PING at a
   time, with 250 ms after each result before the next probe. Timeout is 5 s.
4. Export the CSV with the download icon. Keep this baseline file.
5. Run another 30 samples with `Pause automatic pings` checked and export again.
   CSV series numbers and `automatic_pings` distinguish both conditions even if
   the same export contains both. Heartbeats and directory recovery remain on.
6. For a more reliable A/B comparison, repeat the baseline once more without
   changing distance, program, firmware or connection. Test the other XRP later
   in isolation using the same procedure.

Stopping the series or unmounting the widget cancels the pending test and resumes
automatic pings. The robot program and physical Bluetooth session stay running.
An already queued/transmitting packet cannot be recalled. Pausing automatic pings
does not remove an automatic probe queued before the series started.

## CSV fields

- `rtt_ms`: complete browser-measured PING/PONG RTT, including outgoing waiting.
- `transport`: `ble-data`, `ble-uart`, `usb`, or `unknown` for uninstrumented adapters.
- `packet_bytes`: XPP + MultiAgent packet size. Current PING is 22 bytes.
- `encoded_bytes`: bytes supplied to the transport before retries, not radio
  airtime or total link-layer traffic. DATA PING is 22; UART hex framing is 55.
- `scheduler_queue_ms`: waiting in the per-robot message scheduler.
- `transport_call_ms`: browser transport call duration, including channel checks,
  GATT waiting, writing, retry backoff and recovery when applicable.
- `gatt_queue_ms`: waiting behind earlier GATT operations on this connection.
- `gatt_operation_ms`: GATT write operation duration, including retry/recovery.
  This is part of `transport_call_ms`; do not add the two together.
- `gatt_write_chunks`: logical browser GATT write chunks attempted, not radio
  fragments. DATA currently splits a 22-byte PING into 20 + 2 bytes. UART passes
  the complete text frame to a single write; lower layers may fragment it.
- `gatt_write_attempts` / `gatt_write_retries`: write attempts and extra attempts.
- `after_write_ms`: time from browser transport completion to correlated PONG.
  This includes robot processing, return transport and browser handling. It is
  NOT isolated radio latency, robot processing time, or one-way latency.
- `reply_before_write_completed`: a PONG arrived before the browser write promise
  finished. In that case completion-dependent fields may be blank, and
  `after_write_ms` is deliberately unavailable. Results are frozen at completion.
- `queue_depth_at_enqueue`: scheduler depth, including pending application ACKs.
- `status`: received, timeout or error. Preserve failures in exported datasets.

The table reports mean, conventional median and nearest-rank P95 for received
samples of the latest series only. Do not mix automatic PONGs into this dataset.
No synchronized laptop/robot clock is required for RTT. These measurements do not
instrument firmware BLE buffering, negotiated MTU or connection interval.

The series deliberately retains the existing 22-byte probe: making only the test
packet smaller would not demonstrate an improvement for real control commands.
Use the observed timings to select the next optimization before changing firmware
or increasing traffic toward 30 Hz.

## Diagnostic version 2: automatic probe scheduling

The one-second HEARTBEAT interval and disconnect timeout are unchanged. Automatic
PINGs now wait for their HEARTBEAT write to complete. A probe is skipped if another
write is active/queued, or if an earlier automatic PING still awaits its PONG.
An unanswered automatic probe expires after two seconds. Explicit PINGs and test
probes retain their existing queue priority, packet size and timeout. Reliable
ACKs and emergency-stop priority are unchanged. This does not change UART write
mode or firmware; the robot-side 5 ms output delay is a separate experiment.

Repeat 30 paused samples followed by 30 unpaused samples, with the same one XRP,
program, distance and foreground browser. Export both series together. Retain
failures; a lower RTT alone does not prove sustained 30 Hz control delivery.

Additional CSV fields:

- `diagnostic_version`: 2, distinguishing these results from earlier exports.
- `automatic_ping_policy`: `paused` or `idle-after-heartbeat`.
- `active_write_at_enqueue`: message already being written when the probe arrived.
- `queued_writes_at_enqueue`: queued message labels separated by `|`. DATA labels
  include their topic, e.g. `DATA:TEAM_DIRECTORY`.
- `pending_acks_at_enqueue`: reliable messages awaiting ACK, not active writes.
  The original `queue_depth_at_enqueue` includes these but excludes the active
  write, so it must not be interpreted as the number of preceding writes.
- `blocking_writes`: completed writes that overlapped the probe's queue wait.
- `blocking_write_ms`: sum of those overlapping durations; part of scheduler
  wait, not additional time to add to RTT. Includes failed write attempts.
- `blocking_message_kinds`: unique labels of overlapping writes.
- `automatic_pings_skipped`: cumulative skipped automatic probes since the
  program session started. It is a counter, not the count for this single test.

When a PONG arrives before its browser write finishes, write-dependent fields
remain blank rather than zero. Queue attribution is local to the per-robot
scheduler, not an instrumentation of radio scheduling or all REPL activity.

## Diagnostic version 3: optional UART write experiment

See [BLE UART without-response experiment](BLE_UART_WITHOUT_RESPONSE_TEST.md)
for the guarded USB-console patch, test procedure and rollback. The optional
checkbox requires advertised capability and defaults off. CSV adds the actual
`write_mode` and `uart_without_response_requested`; the 22-byte probe and normal
queue priority remain unchanged. Compare paused series with and without the
write experiment before changing automatic pings or adding a second XRP.

## Optional robot-side observation

See [Robot-side BLE RTT observation](BLE_ROBOT_TIMING_DIAGNOSTIC.md) for a
backed-up USB installation, a separate 90-second probe program and rollback.
It records connection-update/MTU events and local PING handler timings without
changing the protocol or Bluetooth settings. Unknown link parameters remain
unknown; match the robot report to manual CSV probes by sequence and session.

## Diagnostic version 4: small UART frames in one write

See [Small UART frames in one browser write](BLE_UART_55_BYTE_TEST.md) for the
opt-in 20/55/20-byte policy comparison, current MTU/RX checks and CSV fields.
The 55-byte framing is unchanged; only eligible small without-response frames
use one browser write during the selected series. Larger frames remain at 20.
