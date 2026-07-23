# Team messaging with Blockly and Python

This phase lets programs running on two or more USB or Bluetooth IDE robots exchange typed values. The browser laptop is the local coordinator: robot A sends through its existing IDE connection, the laptop validates and routes the packet, and robot B receives it through its own existing connection. USB and Bluetooth robots can be mixed in the same team.

No program is needed before connecting. When a shared program contains an `XRP Team Messages` block or imports `MultiAgentLib`, **Run all** transparently installs the communication library on each assigned XRP and attaches the already-open IDE connections to the router.

## Supported values

- numbers from distance, encoder, IMU, or other sensor blocks;
- text;
- booleans;
- `(x, y)` positions;
- dashboard emotion IDs through the dedicated emotion block.

Channels are short semantic names such as `distance`, `position`, `emotion`, or `ready`. Continuous sensor messages use **latest sensor value**, which replaces obsolete queued values. A directed **important event** requests acknowledgement and bounded retries.

## Bidirectional physical test with two XRPs

1. In `XRPWeb`, run `npm run dev` and open the printed localhost URL in Chrome or Edge.
2. Power on both XRPs and connect each one through **USB XRP fleet** or **Bluetooth IDE robot fleet**.
3. Rename them to unique names such as `Red XRP` and `Blue XRP`.
4. Press **Control all connected XRPs (2)** and create a shared Blockly file.
5. Open the new **XRP Team Messages** toolbox category.
6. Build a `repeat forever` program containing:
   - `broadcast [distance sensor] on channel distance as latest sensor value`;
   - an `if new team message on distance` condition;
   - a `print latest team value on distance` action;
   - a short sleep such as `0.05` seconds.
7. Press the purple **Run all** button. The first run takes longer because the IDE installs `MultiAgentLib` on both robots.
8. Observe the active robot's terminal. Its received values come from the other physical XRP because a robot broadcast is not reflected back to its sender.
9. Move an object independently in front of each rangefinder and switch the active IDE robot to inspect the other terminal after stopping/restarting if needed.

The equivalent ready-to-paste Python example is `XRP_MicroPython/XRPExamples/multiagent_team_channels_demo.py`.

## Target one robot by alias

1. Use `send ... to robot` instead of broadcast.
2. Connect a text value such as `Blue XRP` to the target input. Alias matching ignores letter case.
3. On the receiving side, use either:
   - `latest team value on channel`, for the newest value from any teammate;
   - `latest team value ... from robot`, to keep senders separate in teams larger than two.

The laptop publishes a compact alias/ID directory after every handshake or rename. A program waits briefly for this directory when resolving an alias for the first time.

## Dashboard emotion

The Multi-Agent Lab listens for the existing `xrp:dashboard-emotion-preview` event used by the Emotion Face, chat, voice, custom keywords, and camera. It forwards the latest emotion ID to ready team robots. In Blockly, use **latest dashboard emotion ID**; in Python, use:

```python
emotion_id = team.read("emotion", 0)
```

## Expected runtime behavior

- The **message runtime** section shows the IDE-connected robots after their program starts and completes the HELLO/HELLO_ACK handshake.
- IDs and aliases are assigned by the laptop and remain stable when their hardware identity is recognized.
- Sensor queues stay bounded because old values are coalesced.
- A disconnected target produces an error instead of silently routing to another robot.
- Stop all interrupts all shared programs; connecting and editing files continue to use the existing IDE fleet.

## Scope and performance

Virtual 3- and 6-robot tests exercise 20 Hz logical sensor traffic with bounded queues and no wrong-robot deliveries. This is not a physical Bluetooth latency claim. Use the widget benchmark and exported results to measure physical RTT, p95 latency, loss, and sustainable update rate before setting a RoboCup control frequency.
