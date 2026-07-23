from .constants import PROTOCOL_VERSION


class MultiAgentMessage:
    __slots__ = (
        "protocol_version",
        "kind",
        "flags",
        "source_robot_id",
        "target_robot_id",
        "sequence",
        "topic_id",
        "ttl_ms",
        "payload",
        "arrival_ms",
    )

    def __init__(
        self,
        kind,
        source_robot_id,
        target_robot_id,
        sequence,
        topic_id=0,
        ttl_ms=0,
        payload=b"",
        flags=0,
        protocol_version=PROTOCOL_VERSION,
    ):
        self.protocol_version = protocol_version
        self.kind = kind
        self.flags = flags
        self.source_robot_id = source_robot_id
        self.target_robot_id = target_robot_id
        self.sequence = sequence
        self.topic_id = topic_id
        self.ttl_ms = ttl_ms
        self.payload = bytes(payload)
        self.arrival_ms = 0

    def copy_for_relay(self):
        return MultiAgentMessage(
            self.kind,
            self.source_robot_id,
            self.target_robot_id,
            self.sequence,
            self.topic_id,
            self.ttl_ms,
            self.payload,
            self.flags,
            self.protocol_version,
        )

