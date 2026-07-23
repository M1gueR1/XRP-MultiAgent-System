# QoS and Per-Robot Scheduling

Each session schedules independently in this order:

1. high-priority/emergency queue;
2. reliable event queue;
3. latest-only map;
4. normal bounded queue.

Normal and reliable queues default to 64 and 32 entries. Overflow rejects the publish with an explicit
error and increments dropped metrics. No queue is unbounded.

Robot-side reliable sends keep at most 16 pending ACK entries by default and apply the same 500 ms,
two-retry policy from the normal `poll()` loop; they require no background thread.

## Latest state

LATEST_ONLY uses `targetRobotId + topicId` as the coalescing key. A new unsent drive/pose update replaces
the old update and increments `messagesCoalesced`. It has no ACK by default and uses a short TTL. Old
control updates are dropped rather than delivered late.

## Reliable events

ACK_REQUIRED messages remain pending after the GATT write. Default ACK timeout is 500 ms and maximum
retries is two, for at most three physical write attempts. ACK identifies the original logical source
and sequence. Timeout produces explicit failure; retries never continue forever.

## Emergency stop

EMERGENCY_STOP is high priority. Enqueueing it removes queued DRIVE_VELOCITY updates for that target.
It is sent before remaining normal traffic, so an older queued drive command cannot run immediately
after the stop. An already in-flight GATT write cannot be preempted. This protocol is not safety
certified and does not replace XRP motor watchdogs or established stop mechanisms.

## Health and metrics

Heartbeat and ping run at approximately 1 Hz, not at control rate. Three seconds without receive data is
degraded; six seconds is offline in the UI. Sessions retain counters and identity across disconnect.
Metrics include TX/RX messages and bytes, drop/coalescing/stale/invalid/duplicate counts, reconnects,
current and maximum queue depth, latest/average RTT, and p50/p95/p99 when enough samples exist.
