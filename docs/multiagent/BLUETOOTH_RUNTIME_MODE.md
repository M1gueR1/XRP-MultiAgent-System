# Bluetooth Fleet Runtime Mode

## Two runtime entry paths

Full IDE connection retains all existing programming behavior: UART terminal, Raw/normal REPL,
filesystem operations, uploads, Blockly execution, firmware checks, stop/reset behavior, and plugins.
The dashboard may now hold multiple Full IDE Bluetooth connections and expose one selected robot at a
time to the legacy IDE. This full-IDE fleet uses the standard firmware service and does not require a
user program.

The standalone fleet runtime connection performs only:

1. a user-initiated Web Bluetooth chooser;
2. GATT connection to the existing service;
3. discovery of the dedicated DATA writer and DATA notification characteristics;
4. notification subscription;
5. HELLO/HELLO_ACK handshake;
6. runtime XPP messages, heartbeat, ping, telemetry, commands, and relay.

`WebBluetoothRuntimeTransport` has no dependency on `ConnectionMgr`, `CommandToXRPMgr`, or `PluginMgr`.
It does not discover the terminal characteristics and has no methods for REPL or filesystem work.

Shared Blockly/Python programs use a second entry path: `BluetoothIDETransport` reuses the DATA
characteristics already discovered by each Bluetooth IDE session. This path does not invoke another
device chooser or create another GATT connection. When generated code imports `MultiAgentLib`, Run all
installs the library if needed, attaches each IDE session to the router, and then starts the program.

## Explicit non-actions

Adding a fleet robot does not call `getToREPL`, `getToRaw`, `getToNormal`, `getOnBoardFSTree`,
`clearIsRunning`, `checkIfNeedUpdate`, or `pluginCheck`; send `##XRPSTOP##`; write `/main.py`; interrupt
the running program; or reset/reboot the XRP.

The robot-side application must start `MultiAgentNode` or the higher-level `TeamLink`. Blockly team
blocks generate that initialization automatically. Connection and file editing still require no
preloaded user application.

While running, the node repeats its compact HELLO identity every five seconds. This lets a reconnected
laptop session complete a new handshake without resetting or interrupting the robot program. The
coordinator reuses that session's assigned ID and metrics.

## Web Bluetooth behavior

Each Add XRP press invokes one `requestDevice()` call from the user's click. Device identity uses the
browser-provided opaque ID, robot-reported hardware identity, laptop routing ID, and editable alias.
No MAC address is assumed. Reconnect requires prior browser permission and may still need a new user
gesture depending on browser policy.

The write method capability-detects write-without-response and falls back to the established write
method. Only one write is in flight per robot scheduler.
