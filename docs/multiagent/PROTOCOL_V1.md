# Multi-Agent Protocol Version 1

## Outer XPP frame

```text
Offset  Size  Field
0       2     Start sequence AA 55
2       1     XPP message type 30
3       1     XPP payload length (14 + N)
4       14+N  Multi-agent envelope
18+N    2     End sequence 55 AA
```

Existing XPP message types `0x01`–`0x06` are unchanged. The outer XPP payload remains limited to 255
bytes.

## Binary envelope

All 16-bit fields are unsigned little-endian.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | `protocolVersion`, exactly 1 |
| 1 | 1 | `messageKind` |
| 2 | 1 | flags |
| 3 | 2 | logical source robot ID |
| 5 | 2 | logical target robot ID |
| 7 | 2 | sequence |
| 9 | 2 | topic ID |
| 11 | 2 | TTL milliseconds |
| 13 | 1 | application payload length N |
| 14 | N | opaque application payload, maximum 220 bytes |

Oversized payloads are rejected; they are never truncated. Unknown kinds and protocol versions are
rejected without terminating the receive loop.

## Message kinds

| Value | Kind |
|---:|---|
| `0x01` | HELLO |
| `0x02` | HELLO_ACK |
| `0x03` | HEARTBEAT |
| `0x10` | DATA |
| `0x11` | ACK |
| `0x12` | ERROR |
| `0x20` | PING |
| `0x21` | PONG |

## Flags

| Bit | Name | Behavior |
|---:|---|---|
| `0x01` | ACK_REQUIRED | bounded ACK timeout and at most two retries by default |
| `0x02` | LATEST_ONLY | replace queued message with same target and topic |
| `0x04` | HIGH_PRIORITY | schedule before reliable/latest/normal traffic |
| `0x08` | RELAYED | set by laptop; an already relayed packet is never relayed again |

Bits `0x10`–`0x80` are reserved.

## HELLO payload

```text
protocolVersion:u8
libraryMajor:u8
libraryMinor:u8
maximumApplicationPayload:u8
features:u16 little-endian
hardwareIdentityLength:u8 (0..32)
reserved:u8 (0)
hardwareIdentity:utf8 bytes
```

HELLO uses source 65534 and target 0.

## HELLO_ACK payload

```text
assignedRobotId:u16
coordinatorId:u16 (0)
heartbeatIntervalMs:u16
acceptedProtocolVersion:u8 (1)
```

## ACK and PING/PONG payloads

ACK payload is `acknowledgedSourceRobotId:u16 + acknowledgedSequence:u16`. PING contains the laptop's
two-byte ping sequence; PONG echoes it. RTT is measured by the laptop's monotonic clock. No one-way
latency is claimed.

## Topics

| Value | Topic |
|---:|---|
| `0x0001` | SYSTEM_TEST |
| `0x0002` | ROBOT_STATUS |
| `0x0003` | TEAM_DIRECTORY |
| `0x0100` | EMERGENCY_STOP |
| `0x0101` | DRIVE_VELOCITY |
| `0x0102` | ROBOT_POSE |
| `0x0103` | BALL_STATE |
| `0x0201` | EMOTION_STATE |
| `0x8000` | EDUCATIONAL_DATA typed channel/value envelope |
| `0x8001`–`0xFFFF` | user-defined range |

The core does not interpret topic payloads. The optional emotion payload is exactly
`emotionId:u8 + generation:u16 little-endian + flags:u8`.

## TTL and duplicate behavior

TTL begins at local receipt/enqueue and is checked before queued transmission. Zero disables automatic
expiry and should only be used for explicitly reliable low-frequency messages. Recommended TTLs are
100–200 ms for drive, 100–300 ms for pose, and 1000–3000 ms for emotion/events. Duplicate identity is
`sourceRobotId + sequence`; history is bounded to the most recent 512 laptop entries and 64 robot
entries. Unsigned sequence wraps from 65535 to 0.
