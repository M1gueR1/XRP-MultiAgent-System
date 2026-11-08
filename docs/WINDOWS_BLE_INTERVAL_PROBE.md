# Windows Bluetooth interval probe

This isolated Windows utility requests `ThroughputOptimized` for one existing
XRP Bluetooth link, then releases its request. It does not change the IDE, the
robot's files/autorun, UART bytes, RX flags, 5 ms flush delay, MTU, or pings. There
is no local web server, installer, external package, registry edit, permanent
PowerShell-policy change, administrator requirement, pairing or GATT data write.
The browser keeps owning the normal robot session. Windows still decides which
parameters to negotiate, including when other apps have requests for that link.

## First test: interval only, no RTT collection

1. Connect **only XRP-724e7** by Bluetooth in the dashboard and wait for its IDE
   to be ready. Keep its USB cable for power, but disconnect any USB IDE session.
   Do not connect the second XRP. Do not run the 90-second probe or collect RTT
   samples; this utility obtains the interval from Windows directly. Leave the
   55-byte experiment unchecked. Do not change the existing robot-side patches.
2. In Windows File Explorer, open `tools/windows-bluetooth/` in this repository
   and double-click **run-xrp-ble-interval.cmd**. This runs Windows PowerShell 5.1,
   which is included with Windows 11. No terminal pasting in the XRP IDE is used.
   If Windows or school policy blocks scripts, stop and share the message rather
   than changing system policy or running as administrator.
3. Verify the selected Windows name. Windows can report this XRP as **MPY BTSTACK**
   even though the IDE shows **XRP-724e7**. An XRP-style name uses confirmation
   **YES**; the generic **MPY BTSTACK** name requires **YES XRP** and an explicit
   warning. Continue only if this is your XRP and no other MicroPython board is
   connected. The generic name is not proof of hardware identity. Anything else
   cancels without requesting a profile. Zero/multiple eligible candidates are
   refused. `-DeviceName`, if supplied, matches the Windows name, not an IDE alias.
4. Keep the IDE connected, leave the robot still, and wait about **43 seconds**:
   three baseline readings, 30 seconds holding the request, then 10 seconds of
   observation after release. Lines are labeled `BEFORE`, `DURING`, and `AFTER`.
   Do not disconnect, power-cycle, use Repair, Run, or perform other transfers.
5. Share the console's **RESULT** and the JSON file whose full path follows
   **REPORT**. The report is under `tools/windows-bluetooth/reports/`, excluded
   from Git, and includes all actual readings and any errors. No previous report
   is overwritten. It contains the robot name but not its Bluetooth address/ID.

### If the old utility said zero connected XRPs

The old version filtered out every Windows name not starting with `XRP-`. On the
tested laptop Windows actually returned one **MPY BTSTACK** endpoint, and a
read-only native check confirmed **Connected**, interval **48 units = 60 ms**.
Thus zero eligible names did not mean zero Bluetooth links. The updated utility
enumerates explicit BLE AssociationEndpoints and prints the Windows names before
filtering, accepts this generic MicroPython name only with the extra confirmation,
and still checks the actual native connection and a stable valid baseline before
requesting anything. It does not pair, discover GATT services, or reconnect a robot
to make the name filter pass. Do not change robot firmware or run Repair for this.

The report records the Windows name, its classification and operator confirmation;
`hardware_identity_verified` stays false because this utility does not query the
robot's MicroPython identity. Unsupported/unnamed devices remain ineligible.

## Interpretation and restoration

- `CHECK_OK` means only that the API is available, not that a real robot was tested.
- A profile requesting 15 ms is only a preference. The `BEFORE`/`DURING` values
  come from `GetConnectionParameters`, multiplied by **1.25 ms per unit**.
- `Success` means Windows accepted the request; it does **not** prove negotiation
  of a different interval. Disconnected/invalid zero values become `null`, not 0 ms.
- `interval_reduction_observed` requires three consecutive lower readings than
  the stable baseline. This is evidence about the interval, **not** proof of a
  lower RTT, 30 Hz operation, or support for two simultaneous robots.
- `transient_interval_reduction_observed` is weaker evidence; inspect the timeline.
- `no_interval_reduction_observed` means no reduction was seen in this window;
  do not repeat large RTT series just because the request said `Success`.
- Rejected, unavailable, unstable, disconnected and incomplete trials are not
  successful optimizations. Access can depend on Windows policy and adapter support.
- The request and the device reference that made it are disposed in `finally`,
  including failure paths, using Microsoft's documented restoration path without
  calling disconnect on the browser. A separate read-only reference obtains the
  `AFTER` observations and is also disposed; it never requests a profile.
  Ctrl+C normally executes cleanup; closing/killing the whole process releases its
  native handles but can prevent the report from being written. Prefer waiting.
- Windows may not immediately return to exactly the original interval. `AFTER`
  records what actually happened; we do not force `PowerOptimized` as a substitute
  for the original settings. If necessary, **after the utility exits**, disconnect
  and reconnect Bluetooth in the IDE to start a fresh default session.
- ThroughputOptimized can consume more power and reduce concurrent BLE capacity.
  This is a single-robot experiment, not a fleet-wide default.

Only after an actual reduction is observed should we plan a separate timed RTT
comparison, keeping this request alive for that future experiment. This initial
30-second request ends automatically and cannot affect RTT tests run afterward.

## Second test: RTT at the two intervals

Use this only after the first test actually observed a stable 15 ms interval.
The separate **run-xrp-ble-rtt.cmd** launcher uses the same guarded probe with
`-RttTest -HoldSeconds 180`: a three-minute temporary request, followed by the
same release, recovery observations and JSON report. It does not install or
change anything on the robot. Do not use the original 30-second launcher here.

1. Keep only XRP-724e7 connected by **Bluetooth**; USB supplies power only.
   Close any completed helper window. Keep robot distance and browser unchanged.
2. In the robot IDE, run **XRPExamples/rtt_single_robot.py** and wait for
   **RTT_READY**. This existing program runs until stopped and uses the Python
   communication backend; do not use the finite native benchmark or diagnostic
   programs for this comparison. If this file is already on the robot, no new
   robot files or libraries need uploading. Start it before opening the helper.
3. In **Team Message Log > RTT diagnostic**, set **Samples = 30**, check
   **Pause automatic pings**, and leave **Use 55-byte UART writes unchecked**.
   Keep **Use UART writes without response checked** if it is available; if it
   is disabled, leave it disabled for both series. Do not change this choice
   between A and B. Keep the 5 ms robot flush patch and all other settings fixed.
4. With no helper running, clear old test results, collect **A: 30 baseline RTTs**,
   then export the CSV immediately. Keep failures/timeouts, not only replies.
5. Do not stop or rerun the robot program. Double-click **run-xrp-ble-rtt.cmd**
   on Windows and confirm **YES XRP** for MPY BTSTACK (or YES for an XRP name).
   The three **BEFORE** readings must be 60 ms for this 60-versus-15 comparison.
   If not, do not collect B; let the utility finish and share its JSON.
6. Wait for **three consecutive DURING readings at 15 ms, connected=True,
   request=Success**. Return to the browser, keep it foreground, and immediately
   start **B: another 30 RTTs** with exactly the same options. The Windows helper
   must remain running in the background; this is the window that keeps 15 ms
   requested. Do not press Run again, upload files, reconnect, or use Repair.
7. Export again; without clearing results between A and B, this second CSV has
   **60 rows** in chronological order (first 30 A, next 30 B). Wait for the helper
   to finish normally and share this CSV and its final **REPORT** JSON. The JSON
   timestamps allow checking that B occurred inside the observed 15 ms window.

If the interval changes, a disconnect/error appears, or **AFTER** /
**RTT_WINDOW_CLOSED** begins before B finishes, stop the series and report the
partial results; do not label mixed-interval samples as 15 ms. The window is
bounded and not extended automatically. Completion, failures and normal Ctrl+C
use the existing release logic. Closing/killing the process can lose its report.

This comparison measures sequential laptop-to-robot-to-laptop RTT, not sustained
30 Hz traffic or two-robot capacity. The 250 ms diagnostic pause between samples
is outside each measured RTT. Do not infer throughput solely from reciprocal RTT.

## Read-only checks and development tests

Run these in a Windows terminal from the repository root, not the robot console:

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File tools/windows-bluetooth/XrpBleInterval.ps1 -Mode Check
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File tools/windows-bluetooth/XrpBleInterval.ps1 -Mode List
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/windows-bluetooth/Test-IntervalTrial.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/windows-bluetooth/Test-DeviceDiscovery.ps1
```

Check opens no device. List enumerates connected XRP names without requesting a
profile or opening GATT services. Tests use fake adapters and never touch Bluetooth.
The probe is deliberately not connected to the web app's Run or Connect buttons.

## Primary references

- [Request and restore preferred parameters](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothledevice.requestpreferredconnectionparameters?view=winrt-26100)
- [Read negotiated parameters and invalid disconnected values](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothledevice.getconnectionparameters?view=winrt-26100)
- [Connection interval units](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothleconnectionparameters?view=winrt-26100)
- [Request status: accepted is not negotiated](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothlepreferredconnectionparametersrequeststatus?view=winrt-26100)
- [ThroughputOptimized tradeoffs](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.bluetoothlepreferredconnectionparameters.throughputoptimized?view=winrt-26100)
