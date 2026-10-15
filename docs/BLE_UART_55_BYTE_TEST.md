# Small UART frames in one browser write

This opt-in test compares two without-response write policies on one XRP. The
22-byte PING still has the same 55-byte ASCII framing. It does not change the
robot firmware, packet format, 5 ms flush delay, negotiated MTU, connection
interval, heartbeat, application ACKs, retry count, queue priority or REPL writes.

## Preconditions

Use only XRP-724e7 with the existing without-response RX flag patch and BLE
observer installed. Its reported MTU was 527 and the earlier blerepl source used
`rxbuf = 250`; these are evidence for this robot, not guarantees for other boards
or a future session. Verify the current MTU again after reconnecting. A 55-byte
ATT value requires MTU >= 58 and an RX buffer >= 55. If either is unknown or
smaller, do not accept the confirmation. Web Bluetooth does not expose this
negotiated MTU to this component, so the checkbox does not claim automatic MTU
discovery. MTU/RX eligibility is confirmed by the operator.

Upload the current `XRP_MicroPython/XRPExamples/rtt_ble_probe.py` to `/` through
the IDE's Upload Files command. The existing helper and UART observer do not
need reinstalling. No pasted terminal commands are required. The probe now
prints `BLE_DIAGNOSTIC_LINK: MTU = ... ; interval_ms = ...` at startup, before
the manual samples. The rest of its observation and automatic finish are unchanged.

## A-B-A comparison

1. Refresh the IDE to load the new checkbox. Keep only one XRP logically connected
   through Bluetooth; USB can remain plugged in for power, not an IDE USB session.
2. Run `/rtt_ble_probe.py` on this XRP only. Wait for RTT_READY and the current
   BLE_DIAGNOSTIC_LINK output to finish. If MTU is unknown or below 58, stop the
   55-byte experiment and share that output. Keep distance/browser foreground fixed.
3. In RTT diagnostic, set Samples to 30 and keep **Pause automatic pings** and
   **Use UART writes without response** checked throughout all three series.
4. A: leave **Use 55-byte UART writes** unchecked and collect 30 samples.
5. B: check **Use 55-byte UART writes**, start 30 samples, and accept the MTU/RX
   confirmation only for the verified current robot.
6. A again: uncheck only **Use 55-byte UART writes** and collect another 30 samples.
7. Export all 90 rows together. Keep errors, timeouts and retries in the CSV.
   Complete all three series before the 90-second window ends. If reporting
   starts during a series, discard that comparison and restart; the reporting
   traffic and end of polling are not clean measurement conditions.
8. Wait for BLE_DIAGNOSTIC_SAVED and the IDE to finish. Do not press Bluetooth
   Stop, which can reset the board. Use **Disable autorun safely** in Teacher
   Mode before disconnecting/resetting. For the optional printed JSON, follow
   [the file-and-Run procedure](BLE_ROBOT_TIMING_DIAGNOSTIC.md).

The expected manual PING fields are:

| Policy | encoded_bytes | gatt_write_chunks | gatt_write_chunk_size_bytes |
| --- | --- | --- | --- |
| A, normal without-response | 55 | 3 | 20 |
| B, single small-frame write | 55 | 1 | 55 |

No RTT improvement is promised. Compare RTT mean, median, P95, received count,
write retries, queue time and GATT operation time. One browser write does not
prove one radio packet, nor does its promise resolving prove robot receipt.

## Scope and recovery

The B policy applies to any UART runtime frame <= 55 bytes while the series is
active, not only benchmark PINGs. Larger frames retain 20-byte chunking. DATA and
USB are unchanged, and REPL/upload/stop still use their normal write-with-response
path. When the series ends, fails or is cancelled, the lease is released and the
normal mode is restored. Releasing a nested 55-byte lease while a 20-byte lease
remains restores the 20-byte experiment.

The profile is tied to the physical disconnect generation and UART characteristic.
If either changes, the experimental write is rejected rather than silently
continuing on an unverified connection. Check the new MTU/RX before a new series.
Existing retries remain bounded; a rejected 55-byte write does not silently fall
back to three writes, since that would make the B measurements ambiguous.

CSV diagnostic version 4 adds `uart_chunk_size_requested` (20 or 55 when the
without-response experiment was selected) and `gatt_write_chunk_size_bytes`
(effective maximum browser chunk size for that message). Actual mode and count
remain recorded. Blank actual fields mean unavailable, not zero-byte writes.
