# Robot-side BLE RTT observation

This is a diagnostic, not another latency optimization. It does not change the
PING/PONG bytes, MTU, connection interval, RX flags, indication mode, 5 ms flush
delay, health checks, retries, or the MultiAgentLib files. The installer changes
only the existing UART file by adding an import and an observer call before its
original IRQ body. The original IRQ handler remains in control.

## Install once through USB

1. Use only XRP-724e7. Stop its program and disconnect its Bluetooth IDE session.
   Connect this same robot through USB in the dashboard. In Robot Chat, unlock
   Teacher Mode and use **XRP Boot Safety / Autorun Tools -> Disable autorun
   safely**. Confirm and wait for success; this preserves the previous launch
   file before the first Run below changes it.
2. Use the IDE's Upload Files command to upload both files from
   `XRP_MicroPython/XRPExamples/` into the robot's root folder `/`:
   - `rtt_ble_diagnostic.py`
   - `rtt_ble_probe.py`
   Upload them, but do not run the helper itself. It defines functions and does
   not install anything just by being run or imported.
3. Create `/install_ble_diagnostic.py` with this code and use **Run in this XRP**
   while connected through USB (no console pasting is needed):

   ```python
   import rtt_ble_diagnostic as d
   d.install()
   ```

   Expected output: `SUCCESS: BLE observer installed.` The backup is
   `/lib/ble/ble_uart_peripheral.py.before_rtt_diagnostic.bak`. The patch is
   compiled before writing, the backup is verified, and changed files are staged
   and verified before rename. An unexpected source, mismatched backup or staging
   file causes an error rather than an overwrite. Stop and share any error.
   Repeating a successful installation is safe and prints `ALREADY_INSTALLED`.
4. After the installer finishes, click **Disable autorun safely** again and wait
   for success. Each IDE Run rewrites the launch file, so the earlier click alone
   does not prevent the installer launcher from running again on reset.
5. Disconnect the USB IDE session, unplug/replug power, and connect only through
   Bluetooth. Leave the USB cable connected for power. The helper file must stay
   at `/rtt_ble_diagnostic.py` while the observer is installed.

The diagnostic's install function never changes `main.py` or `boot.py`, and
Upload Files does not launch a program. However, **IDE Run does update main.py**,
which is why Boot Safety is required before and after the installer Run. Boot
Safety makes verified backups rather than discarding the previous launch file.

## Collect one diagnostic window

1. Open `/rtt_ble_probe.py` and use Run in this XRP only. Its explicit
   `MultiAgentLib` import makes the IDE prepare the normal Bluetooth team runtime.
   The probe reuses the observer retained by the live UART module even when the
   IDE's pre-Run cleanup clears its original import-cache entry.
2. Wait for `RTT_READY` and `BLE_DIAGNOSTIC_WINDOW`. The robot collects for 90
   seconds after its team handshake. Keep the browser foreground and robot fixed.
3. Start 30 samples promptly. Keep **Pause automatic pings checked** and **Use
   UART writes without response checked**. Do not send other console commands,
   print repeatedly, move the robot, or run a second series beyond the window.
4. Export the usual RTT CSV when the series finishes. Then wait until the robot
   console says `BLE_DIAGNOSTIC_SAVED: /ble_rtt_report.json`. Do not stop early:
   sampling is RAM-only and an early reset loses the unsaved window.
5. After that marker, the program finishes by itself. Wait for the IDE to be
   idle; **do not press Stop or power-cycle**. Use
   **Disable autorun safely** again before changing connections or power-cycling,
   so the probe does not restart automatically. Disconnect Bluetooth and
   reconnect this robot by USB. Create `/read_ble_report.py` with this code and
   use **Run in this XRP** through USB:

   ```python
   print(open('/ble_rtt_report.json').read())
   ```

6. Share the whole printed report and the CSV. After the read program finishes,
   click **Disable autorun safely** again before resetting/reconnecting. A later
   completed window replaces this report; retain it before another window.

There are no per-PING prints or flash writes during the window. A small startup
announcement happens before the manual series, and the file/finish announcement
is emitted after the window. If the manual test has not finished by 90 seconds,
discard that series and rerun; final reporting traffic is not part of a clean
measurement. After saving, the program returns to REPL without resetting or
disconnecting Bluetooth. Team polling stops, so the fleet can later mark the
team runtime unready; the Bluetooth IDE connection remains available for Boot
Safety. This is intentional at the end of the diagnostic, not a link failure.

## Interpret the report

- `connection_interval_ms`: last successfully observed update, in 1.25 ms units.
  **null means unknown**, not a zero/default interval. Some firmware/stack
  sessions do not emit an update, or the initial connection parameters are never
  exposed to this hook. We cannot infer them from RTT alone.
- `negotiated_mtu`: observed MTU exchange for this connection. **null means
  unknown**, not the preferred `BLE.config('mtu')` value or an assumed default.
- `peripheral_latency_events`: permitted skipped connection events, not measured
  milliseconds of delay. Supervision timeout is recorded in raw 10 ms units.
- `ble_at_ready` / `ble_at_end`: both snapshots include event counts and the last
  connection-update status. A failed update does not replace prior successful
  parameters. Disconnect/reconnect clears parameters to avoid stale values.
- `ping_sequence`: join this to the laptop CSV's `ping_sequence`, with the same
  hardware identity and session. The report includes automatic PINGs too because
  their wire format is identical. Analyze only matching manual CSV probes.
- `read_call_us`: duration of the most recent transport read returning bytes
  before this PING's handler. For UART this includes polling/ASCII decoding in
  that call. It excludes prior waiting in BLE/stdin and earlier fragmented reads.
- `read_return_to_handler_us`: parser/dispatch time after that read. It may
  include earlier messages from the same chunk; it is not GATT-arrival latency.
- `handler_us`: accepted PING handling through return from the normal handler.
  It **includes** `pong_submit_us`, so do not add these two durations together.
- `pong_submit_us`: normal `send_control(PONG)` call, including encoding and
  submitting to stdout/transport. Completion does **not** prove radio delivery,
  indication acknowledgment, or receipt by the laptop.
- `poll_gap_us`: time between starts of two node polls, not an exact per-message
  receive-queue delay. Includes the unchanged 5 ms loop sleep and previous work.

All robot-side durations use its local wrapping `ticks_us` clock; they are not
directly comparable with laptop timestamps. The recorder retains the newest 180
accepted PINGs, reports any discarded samples, and drops duplicate/invalid PINGs
from timing only if the original handler did not submit a PONG. Instrumentation
adds overhead: compare with the previous uninstrumented series, and do not label
this measurement as an optimization. No radio/return-path delay is isolated yet.

## Restore the UART observer

With the program stopped, Bluetooth disconnected and this robot connected by USB,
create `/restore_ble_diagnostic.py` with this code and Run in this XRP:

```python
import rtt_ble_diagnostic as d
d.restore()
```

The restore refuses to replace a UART file edited since installation. It restores
the exact diagnostic backup, retaining the earlier RX without-response flags and
the separate 5 ms blerepl setting. After success, use **Disable autorun safely**
again, disconnect the USB IDE session and power-cycle before reconnecting BLE.
Do not delete the helper while the UART still imports it.

## Primary references

- MicroPython v1.25 IRQ events, MTU and indication completion:
  https://docs.micropython.org/en/v1.25.0/library/bluetooth.html
- MicroPython v1.25 BTstack passes raw connection-update HCI units to Python:
  https://github.com/micropython/micropython/blob/v1.25.0/extmod/btstack/modbluetooth_btstack.c
