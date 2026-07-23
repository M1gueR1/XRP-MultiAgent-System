# Blockly Team Messaging Integration

Blockly remains an application adapter over the tested fleet API. The first implemented block set provides:

- typed channel/value messages to one robot by ID or alias;
- broadcasts to all other robots;
- latest-value and important-event modes;
- new-message, latest-value, sender-ID, and per-source mailbox blocks;
- `(x, y)` position values and the latest dashboard emotion ID.

Generators call the classroom-facing `TeamLink` API and never build XPP frames or touch GATT
characteristics. `TeamLink` delegates transport, validation, retries, and bounded buffering to
`MultiAgentNode`, while the laptop `RobotFleetManager` remains the coordinator and router.

An event-style `when a message is received` hat block remains a future classroom iteration. The explicit
new-message/read blocks are the initial model because their polling behavior is visible and predictable in
MicroPython loops. Physical routing and block wording should be classroom-tested before adding the event layer.
