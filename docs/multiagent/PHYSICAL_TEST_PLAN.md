# Physical BLE Test Plan

Automated tests use virtual transports and do not prove radio performance. Record board, browser,
operating system, XRP firmware, MultiAgentLib version, distance, interference, and battery state.

## Two robots

1. Upload/run an application that explicitly creates and starts `MultiAgentNode` on each XRP.
2. Start XRPWeb in a Web Bluetooth-capable secure browser.
3. Open Dashboard, add Multi-Agent Lab, press Add XRP, and select Robot A.
4. Press Add XRP again and select Robot B.
5. Verify separate cards and successful handshakes.
6. Confirm neither robot reset, entered Raw REPL, stopped its program, or changed `/main.py`.
7. Ping A and B and record independent RTT values.
8. Disconnect A; verify B still pings and receives messages.

## Routes

1. Send SYSTEM_TEST to A; confirm B does not receive it.
2. Broadcast SYSTEM_TEST; confirm A and B receive independent copies.
3. Have A send SYSTEM_TEST to B's assigned ID.
4. Confirm the routing log shows A → B, B sees logical source A, ACK returns, and no loop occurs.

## Optional emotion demonstration

1. Keep reaction rules disabled and confirm an emotion event does not change another robot.
2. Enable one explicit rule: A Sad → B Puzzled.
3. Change A once; confirm one compact state event and one reaction.
4. Disable the rule; confirm later changes do not affect B.

## Three-robot rate test

1. Connect three robots and run independent latest-only control test data for at least 60 seconds.
2. Repeat at 10, 15, 20, and 25 Hz.
3. Export each benchmark JSON.
4. Record actual sends/receives per second, RTT p50/p95/p99, drops, coalescing, stale packets, maximum
   queue depth, disconnects, and reconnects.
5. Repeat with motors active and, separately, with Red Vision if those combinations are intended.

Do not claim a supported physical frequency above the measured stable result. RTT/2 is not reported as
exact one-way latency.

