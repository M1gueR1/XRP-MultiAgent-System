# Optional C communication prototype

## What is implemented, and what is not

`XRP_MicroPython/native/xrp_comm/` contains a real C implementation of the current
multi-agent envelope encoder/decoder and bounded XPP stream parsing. The module
is compiled into `xrp_comm_native.mpy` and imported by the optional Python adapter
`MultiAgentLib.native_codec.NativeCodecBackend`. Normal programs still use Python;
the native module is never automatically imported or uploaded by the IDE.

The normal node retains identity assignment, readiness, sequence generation,
duplicate checks, TTL, topic delivery, ACKs and retries. There is no special C
autoresponder that would bypass these checks just to obtain a smaller ping number.
The browser's bundle includes only the lightweight Python adapter, not a binary.

**This phase does not bypass BLE UART/REPL, change the radio connection interval,
replace the Bluetooth stack, or prove 30 Hz.** It isolates the processing benefit
of C before a more invasive native binary DATA transport or firmware integration.
A slow serial-read path may still dominate. Do not call host CPU timings XRP RTT.

## First action on the physical robot: compatibility only

1. Use **XRP-724e7** first, with its program stopped and its Bluetooth IDE session
   disconnected. Connect it through USB in the dashboard.
2. Unlock Teacher Mode, use **XRP Boot Safety / Autorun Tools -> Disable autorun
   safely**, confirm and wait. This backs up the previous launch file before Run
   overwrites it. Keep a computer-side copy of important programs as usual.
3. Through Upload Files, upload
   `XRP_MicroPython/XRPExamples/native_comm_capabilities.py` to the root folder `/`.
   Open that file and choose **Run in this XRP**. No console pasting is needed.
   No library updates or C binary are required for this step.
4. Share everything between **NATIVE_CAPABILITIES_BEGIN** and
   **NATIVE_CAPABILITIES_END**. The file reports the actual firmware's native
   architecture and `.mpy` ABI, not a guess based on its marketing board name.
5. Once finished, use **Disable autorun safely again** before resetting or changing
   connections: each IDE Run updates `main.py`, including this harmless report.

The capability report does not import C, start/stop Bluetooth, move motors, or
write robot files itself. Its `visible_binary_data_api: null` means unknown if
the firmware does not expose its UART object; it does not prove DATA is absent.
The IDE's own Run/boot behavior is why Boot Safety is still necessary.

**Stop here until compatibility has been reviewed.** In particular, do not copy
the Linux x64 binary onto an XRP and do not flash different firmware to try it.

## Built artifacts and compatibility gate

Generated artifacts live in `tools/native-build/artifacts/` (Git-ignored):

- `armv6m/xrp_comm_native.mpy`, for compatible ARM Thumb firmware;
- `armv7m/xrp_comm_native.mpy`, for compatible Thumb-2 firmware;
- `x64/xrp_comm_native.mpy`, only for the Linux MicroPython tests;
- `manifest.json`, with source/firmware commit, hashes and actual binary headers;
- `host-cpu-benchmark.json`, explicitly labeled Linux x64, not XRP performance.

Current builds use official MicroPython **v1.25.0**, commit
`f498a16c7db6d4b2de200b3e0856528dfe0613c3`, `.mpy` ABI **6.3**, requiring
31-bit small integers. The manifest's `hardware_verified` remains **false**.
Architecture IDs 4/5 correspond to armv6m/armv7m. Upstream's Thumb loader accepts
compatible lower Thumb variants, but the installed preview firmware must still
be checked. A different architecture, ABI or unsupported firmware requires a
separate build/review, not renaming an incompatible file. The two robots have
different firmware variants and must not be assumed interchangeable.

Native code can crash the VM if incompatible or faulty. The Python wire self-test
checks ordinary behavior after import; it cannot make an incompatible native
binary safe. Do the first import and offline benchmark over USB with backups.

## Later: staged comparison after compatibility approval

1. Back up the robot's current MultiAgentLib and launch files. Prepare/update its
   normal team library through USB with the updated IDE; this installs the new
   node and Python adapter but does not enable C. Upload only the reviewed ARM
   binary as `/lib/xrp_comm_native.mpy`; do not overwrite unrelated files or place
   a same-named `.py` beside it (Python source would shadow the binary).
2. Upload and Run `native_comm_benchmark.py` over USB. Its JSON compares Python
   and actual native code for 2-, 32- and 220-byte payloads with ABBA ordering.
   It measures **offline CPU processing**, not wireless RTT. A missing/incompatible
   module fails visibly; there is no silent Python fallback masquerading as C.
   Use Boot Safety before/after the Run as above. Share the whole JSON.
3. First perform the separate Windows interval-only probe in
   `WINDOWS_BLE_INTERVAL_PROBE.md`. It is temporary: an RTT test started after its
   utility exits does not inherit its requested profile. Do not mix interval
   changes with a Python-versus-C comparison or change both between A/B runs.
4. If CPU results justify an RTT experiment, upload `native_comm_rtt.py` and run
   it on one robot by Bluetooth. `USE_NATIVE = False` is the baseline; `True`
   explicitly selects C. Each Run gives a **fresh 90-second window for one series
   of 30 samples**, returning to REPL without reset. Do not fit multiple series
   into one window or send pings after the program reports it finished.
5. Keep distance, negotiated interval, 5 ms output flush, browser foreground,
   traffic, automatic-ping pause and UART write mode identical. Keep 55-byte mode
   off. Both versions run the same normal PING/PONG path and 5 ms loop sleep.
   Record the backend label with each CSV; that metadata is not added to the
   existing CSV schema automatically. Compare all replies, timeouts, mean,
   median and P95, not just the fastest run. Use Boot Safety before any reconnect.

Do not change ordinary classroom programs until real hardware data supports the
change. To stop using C, use the baseline script or the unchanged normal team
API; native code is opt-in per node. Removing the reviewed `.mpy` via USB after
stopping the test and applying Boot Safety restores the normal Python-only setup.
Keep the adapter/node sources or restore their backed-up pair together.

The next architectural phase, if justified, is a dedicated bounded binary BLE
DATA route reusing the existing stack while preserving the IDE REPL and stop
behavior. It may require rebuilding the exact XRP firmware. This prototype has
not installed any firmware or added a second Bluetooth owner/IRQ handler.

## Reproduce the isolated build

The builder does not mount any serial/Bluetooth device. The repository is
read-only; output goes to the ignored artifacts directory. Build tooling is in
a separate Docker image, not installed globally or added as app dependencies.
The image consumes about 1 GB of local space. No unrelated Docker services are
stopped or changed.

From the repository root in a Windows terminal:

```powershell
git clone --depth 1 --branch v1.25.0 https://github.com/micropython/micropython.git tools/native-build/.cache/micropython
git -C tools/native-build/.cache/micropython archive --format=tar --output=../micropython-v1.25.0.tar HEAD
docker build -t xrp-native-builder:1 tools/native-build
New-Item -ItemType Directory -Force tools/native-build/artifacts
$root = (Get-Location).Path
docker run --rm --network none --mount "type=bind,source=$root,target=/workspace,readonly" --mount "type=bind,source=$root\tools\native-build\artifacts,target=/out" xrp-native-builder:1
```

Clone only if that cache does not already exist. The build rejects a different
commit or archive hash. It runs ASan/UBSan malformed-buffer tests, compiles an
actual Linux MicroPython interpreter, imports/tests the real x64 C module, runs
the offline benchmark, and cross-compiles both ARM variants. Cross-compilation
and x64 execution are **not** substitutes for validation on an actual XRP.

Primary references: [native .mpy modules](https://docs.micropython.org/en/v1.25.0/develop/natmod.html),
[ABI compatibility](https://docs.micropython.org/en/v1.25.0/reference/mpyfiles.html),
[upstream Thumb architecture check](https://github.com/micropython/micropython/blob/v1.25.0/py/persistentcode.h).
