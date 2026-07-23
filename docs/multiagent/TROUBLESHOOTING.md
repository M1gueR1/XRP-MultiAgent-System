# Multi-Agent Troubleshooting

| Symptom | Checks |
|---|---|
| Device does not appear | Use a secure Chromium-based browser, enable Bluetooth, power the XRP, and confirm its advertised name starts with XRP. |
| Permission denied | Press Add XRP again from a user click and accept the browser/OS chooser permission. |
| DATA characteristic missing | Confirm the XRP firmware/library version exposes `92ae6088-...36ff` and `...36fe`; full IDE BLE may still work without them. |
| Handshake timeout | Confirm the running robot program explicitly called `MultiAgentNode.start()` and is polling; importing the library is insufficient. |
| Duplicate robot ID | Disconnect the duplicate session, clear the known-robot browser entry if hardware identities collide, and reconnect one at a time. |
| Target offline | Check target card state/last seen, reconnect it, then retry; the router does not queue indefinitely for offline robots. |
| High queue depth | Lower rate, use LATEST_ONLY for state, shorten TTL, inspect radio conditions, and avoid ACK on high-rate control. |
| Lost notification | Inspect invalid/drop metrics, verify notification subscription, then disconnect/reconnect that session only. |
| Malformed XPP packet | Compare framing/length/version with PROTOCOL_V1; the parser will bound and resynchronize its buffer. |
| Robot unexpectedly resets | Verify it was added through Multi-Agent Lab, not the full IDE Bluetooth connection. Fleet runtime never sends `##XRPSTOP##`. |
| `/main.py` autorun warning | Fleet runtime does not write `/main.py`; inspect full IDE upload/update actions and the robot's existing autorun configuration. |
| Physical frequency below requested | Export benchmark data, check RTT/coalescing/drop/queue metrics, reduce rate, test fewer robots, and report measured limits. |

The current XRP firmware's DATA callback may be a single callback slot. If gamepad and MultiAgentLib
compete, do not monkey-patch private objects; add and test an explicit firmware callback multiplexer.

