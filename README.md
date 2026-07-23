# XRP Multi-Agent System

Local Bluetooth Low Energy communication and routing for multiple XRP robots.

This repository is an independent project derived from the XRP Emotion System. Its first working
topology is a centralized star: XRP robots connect independently to XRPWeb, and the laptop coordinates
laptop-to-robot, broadcast, robot-to-laptop, and logical robot-to-robot messages. Robot-to-robot traffic
is physically relayed by the laptop while preserving the originating robot ID.

```text
XRP Robot A ── BLE/XPP ──┐
XRP Robot B ── BLE/XPP ──┼── XRPWeb coordinator and router
XRP Robot C ── BLE/XPP ──┘
```

Bluetooth is the physical transport. XPP remains the framing protocol. `MultiAgentLib` is the general
robot-side protocol/API, `RobotFleetManager` owns independent laptop sessions and routing, and the
emotion adapter is one optional application. The runtime protocol does not use Wi-Fi, Internet, cloud
services, remote WebSockets, Firebase, Supabase, or an external message broker.

## Repository structure

```text
XRPWeb/                         React + TypeScript IDE, fleet manager and Multi-Agent Lab
XRP_MicroPython/MultiAgentLib/ Robot-side MicroPython protocol and polling API
XRP_MicroPython/XRPExamples/   Generic relay and optional emotion examples
docs/multiagent/               Architecture, protocol, audit and test documentation
```

## Run XRPWeb

```bash
cd XRPWeb
npm ci
npm run dev
```

Production validation:

```bash
npm run test -- --run
npm run build
```

## Robot application

Upload `MultiAgentLib` without replacing the existing XRP BLE firmware. A running application starts
the node explicitly and polls it from its normal loop:

```python
from MultiAgentLib import MultiAgentNode

node = MultiAgentNode("stable-hardware-identity")
node.start()

while True:
    node.poll()
    message = node.receive()
    if message is not None:
        print(message.source_robot_id, message.topic_id, message.payload)
```

Importing MultiAgentLib does not start Bluetooth, reset the robot, modify `/main.py`, initialize Wi-Fi,
or touch the filesystem. Fleet runtime assumes `ble.blerepl` is already active and uses only its
dedicated DATA API.

## Documentation

Start with:

- [Architecture](docs/multiagent/ARCHITECTURE.md)
- [Current communication audit](docs/multiagent/CURRENT_COMMUNICATION_AUDIT.md)
- [Protocol version 1](docs/multiagent/PROTOCOL_V1.md)
- [BLE runtime mode](docs/multiagent/BLUETOOTH_RUNTIME_MODE.md)
- [QoS and scheduling](docs/multiagent/QOS_AND_SCHEDULING.md)
- [Physical test plan](docs/multiagent/PHYSICAL_TEST_PLAN.md)

Direct XRP-to-XRP BLE is a documented future experiment, not part of the production path.
