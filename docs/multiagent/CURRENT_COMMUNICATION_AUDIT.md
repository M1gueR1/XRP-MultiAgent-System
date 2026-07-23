# Current XRP Communication Audit

## Scope and repository safety

The audited repository root is `XRP-MultiAgent-System`. Its fetch and push remote is
`https://github.com/M1gueR1/XRP-MultiAgent-System.git`; no writable remote points to
`M1gueR1/XRP-Emotion-System`. The audit was performed before implementation.

## Current USB path

Robot to laptop:

1. Human-readable MicroPython output and XPP binary output share the USB serial stream.
2. XPP publishers write bytes to `sys.stdout.buffer` when no active BLE DATA connection exists.
3. `USBConnection.readWorker()` reads arbitrary serial chunks.
4. `Connection.extractCompleteXPPPackets()` retains partial frames in the connection's `xppBuffer`.
5. Complete XPP frames go to `Joystick.handleXPPMessage()` and `TableMgr.readFromDevice()`.
6. Non-XPP bytes continue through `Connection.readData()` to the terminal.

Laptop to robot uses the Web Serial writer through `USBConnection.writeToDevice()`. Existing IDE
operations use the same channel for REPL control, source upload, and XPP joystick data.

## Current BLE terminal path

The browser discovers Nordic UART service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`.

- Browser writes terminal/REPL bytes to characteristic `6e400002-...`.
- Browser subscribes to terminal notifications on characteristic `6e400003-...`.
- Terminal notifications pass to `Connection.readData()`.

The characteristic labels are not treated as proof of direction; the directions above are based on
the actual browser operations in `BluetoothConnection`.

## Current BLE binary DATA path

The existing browser code uses two characteristics under the UART service:

- Laptop to robot: browser writes to `92ae6088-f24d-4360-b1b1-a432a8ed36ff`.
- Robot to laptop: browser subscribes to notifications on `92ae6088-f24d-4360-b1b1-a432a8ed36fe`.

On the MicroPython-facing API:

- `ble.blerepl.uart.write_data(packet)` publishes robot-to-laptop DATA notifications.
- `ble.blerepl.uart.set_data_callback(callback)` delivers laptop-to-robot DATA bytes, as demonstrated
  by `XRPLib/gamepad.py`.

Therefore the exposed DATA API is bidirectional and does not use `sys.stdin`. However, the source for
`ble.blerepl`, the Radio Module firmware, and its internal DATA queue/IRQ implementation is not in this
repository. Its internal behavior cannot be source-verified here and must be verified on physical XRP
firmware. `MultiAgentTransport` uses the smallest explicit public bridge: it attaches to the existing
`write_data` and `set_data_callback` methods only after application code calls `start()`.

## Existing XPP framing and types

Framing is unchanged:

```text
AA 55 | messageType:u8 | payloadLength:u8 | payload | 55 AA
```

Existing assigned types found in source:

| Type | Meaning |
|---:|---|
| `0x01` | Variable definition |
| `0x02` | Variable update |
| `0x03` | Variable subscribe |
| `0x04` | Variable unsubscribe |
| `0x05` | Program start |
| `0x06` | Program stop |

Repository inspection found no XPP assignment for `0x30`; it is now centrally assigned to
`XPP_MULTI_AGENT`. Existing values, tables, joystick packets, starts, ends, and the 255-byte outer
payload limit are unchanged.

## Existing partial-packet buffering

`Connection.extractCompleteXPPPackets()` buffers partial frames per legacy `Connection`, extracts
multiple frames, passes terminal bytes through on USB, and resynchronizes after a bad end marker. It
did not cap its receive buffer. The fleet implementation uses a separate bounded `XppStreamParser`
for every `RobotSession`; malformed data cannot share state between robots.

## Why the existing BLE connection cannot be used for fleet runtime

`BluetoothConnection.onConnected()` enters `ConnectionMgr.connectCallback()`. That callback may:

- call `getToREPL()`;
- send `##XRPSTOP##`, causing a reboot when no prompt is found;
- inspect the onboard filesystem;
- enter normal/raw REPL;
- clear running flags;
- check firmware and hardware identity;
- run plugin checks.

This is correct for the full IDE and unsafe for adding a running fleet robot. The new
`WebBluetoothRuntimeTransport` is independent: it discovers only the service and DATA characteristics,
subscribes to DATA, and performs the binary multi-agent handshake.

## Files extended by the implementation

- `XRPWeb/src/multiagent/`: protocol, transports, sessions, routing, QoS, metrics, simulator, benchmark.
- `XRPWeb/src/components/dashboard/sensors/MultiAgentLabWidget.tsx`: fleet developer UI.
- `XRPWeb/src/components/dashboard/xrp-dashboard.tsx` and `AddWidget.tsx`: widget registration.
- `XRP_MicroPython/MultiAgentLib/`: general robot-side library.
- `XRP_MicroPython/XRPExamples/`: generic and optional emotion examples.
- `docs/multiagent/`: design, protocol, test, and troubleshooting documentation.

## Known limitations discovered

- Browser JavaScript does not expose a dependable Bluetooth MAC address.
- Web Bluetooth requires a secure context and a user gesture for each new device chooser.
- The firmware DATA callback appears to be a single callback slot; using gamepad and MultiAgentLib at
  the same time may require a firmware-side callback multiplexer. This must not be monkey-patched.
- The repository cannot prove physical notification size, connection count, sustained rate, radio
  scheduling, or simultaneous motor/Red Vision performance.

