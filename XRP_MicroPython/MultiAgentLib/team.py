"""Classroom-friendly typed communication built on the multi-agent protocol."""

import struct

try:
    import time
    sleep_ms = time.sleep_ms
    ticks_ms = time.ticks_ms
    ticks_diff = time.ticks_diff
except AttributeError:
    import time
    sleep_ms = lambda milliseconds: time.sleep(milliseconds / 1000.0)
    ticks_ms = lambda: int(time.time() * 1000)
    ticks_diff = lambda newer, older: newer - older

try:
    import machine
    import ubinascii
except ImportError:
    machine = None
    ubinascii = None

from .constants import (
    BROADCAST_ROBOT_ID,
    FLAG_ACK_REQUIRED,
    FLAG_LATEST_ONLY,
    TOPIC_EDUCATIONAL_DATA,
    TOPIC_EMOTION_STATE,
    TOPIC_TEAM_DIRECTORY,
)
from .node import MultiAgentNode


EDUCATIONAL_PAYLOAD_VERSION = 1
VALUE_NONE = 0
VALUE_BOOLEAN = 1
VALUE_INTEGER = 2
VALUE_NUMBER = 3
VALUE_TEXT = 4
VALUE_VECTOR2 = 5
MAX_CHANNEL_BYTES = 32


def _default_hardware_identity():
    if machine is not None and ubinascii is not None:
        try:
            return ubinascii.hexlify(machine.unique_id()).decode("ascii")
        except Exception:
            pass
    return "xrp-team-node"


def _normalize_channel(channel):
    channel = str(channel).strip().lower()
    if not channel:
        raise ValueError("message channel cannot be empty")
    encoded = channel.encode("utf-8")
    if len(encoded) > MAX_CHANNEL_BYTES:
        raise ValueError("message channel cannot exceed 32 UTF-8 bytes")
    return channel, encoded


def encode_typed_value(channel, value):
    channel, channel_bytes = _normalize_channel(channel)
    if value is None:
        value_type = VALUE_NONE
        value_bytes = b""
    elif isinstance(value, bool):
        value_type = VALUE_BOOLEAN
        value_bytes = bytes((1 if value else 0,))
    elif isinstance(value, int):
        if value < -2147483648 or value > 2147483647:
            raise ValueError("integer message value must fit in signed 32 bits")
        value_type = VALUE_INTEGER
        value_bytes = struct.pack("<i", value)
    elif isinstance(value, float):
        value_type = VALUE_NUMBER
        value_bytes = struct.pack("<f", value)
    elif isinstance(value, str):
        value_type = VALUE_TEXT
        value_bytes = value.encode("utf-8")
    elif isinstance(value, (tuple, list)) and len(value) == 2:
        value_type = VALUE_VECTOR2
        value_bytes = struct.pack("<ff", float(value[0]), float(value[1]))
    else:
        raise TypeError("message value must be None, boolean, number, text, or an (x, y) pair")
    payload = bytes((EDUCATIONAL_PAYLOAD_VERSION, value_type, len(channel_bytes))) + channel_bytes + value_bytes
    if len(payload) > 220:
        raise ValueError("typed message exceeds the 220-byte application limit")
    return channel, payload


def decode_typed_value(payload):
    payload = bytes(payload)
    if len(payload) < 3 or payload[0] != EDUCATIONAL_PAYLOAD_VERSION:
        raise ValueError("unsupported educational message payload")
    value_type = payload[1]
    channel_length = payload[2]
    value_offset = 3 + channel_length
    if channel_length == 0 or channel_length > MAX_CHANNEL_BYTES or value_offset > len(payload):
        raise ValueError("invalid educational message channel")
    channel = payload[3:value_offset].decode("utf-8").strip().lower()
    value_bytes = payload[value_offset:]
    if value_type == VALUE_NONE and len(value_bytes) == 0:
        value = None
    elif value_type == VALUE_BOOLEAN and len(value_bytes) == 1:
        value = value_bytes[0] != 0
    elif value_type == VALUE_INTEGER and len(value_bytes) == 4:
        value = struct.unpack("<i", value_bytes)[0]
    elif value_type == VALUE_NUMBER and len(value_bytes) == 4:
        value = struct.unpack("<f", value_bytes)[0]
    elif value_type == VALUE_TEXT:
        value = value_bytes.decode("utf-8")
    elif value_type == VALUE_VECTOR2 and len(value_bytes) == 8:
        value = struct.unpack("<ff", value_bytes)
    else:
        raise ValueError("typed message value does not match its type tag")
    return channel, value


class TeamLink:
    """Typed channels and latest-value mailboxes for an XRP team."""

    def __init__(self, hardware_identity=None, node=None, maximum_channels=32):
        self.node = node or MultiAgentNode(hardware_identity or _default_hardware_identity())
        self.maximum_channels = maximum_channels
        self._mailboxes = {}
        self._fresh = set()
        self._source_mailboxes = {}
        self._source_fresh = set()
        self._directory = {}
        self._robot_names = {}
        self._last_sender = {}
        self._started = False
        self.node.on_topic(TOPIC_EDUCATIONAL_DATA, self._on_educational_message)
        self.node.on_topic(TOPIC_TEAM_DIRECTORY, self._on_directory_message)
        self.node.on_topic(TOPIC_EMOTION_STATE, self._on_emotion_message)

    def start(self):
        if not self._started:
            self.node.start()
            self._started = True
        return self

    def update(self):
        if not self._started:
            self.start()
        return self.node.poll()

    def is_ready(self):
        self.update()
        return self.node.ready

    def wait_until_ready(self, timeout_ms=5000):
        if not self._started:
            self.start()
        started_at = ticks_ms()
        while not self.node.ready:
            self.node.poll()
            if ticks_diff(ticks_ms(), started_at) >= timeout_ms:
                return False
            sleep_ms(10)
        return True

    @property
    def robot_id(self):
        self.update()
        return self.node.robot_id

    def known_robots(self):
        self.update()
        return dict(self._directory)

    def robot_name(self, robot_id):
        self.update()
        if robot_id is None:
            return None
        robot_id = self.resolve_target(robot_id)
        return self._robot_names.get(robot_id, "Robot " + str(robot_id))

    def resolve_target(self, target):
        if isinstance(target, bool):
            raise TypeError("robot target must be an ID or alias")
        if isinstance(target, int):
            if target < 0 or target > BROADCAST_ROBOT_ID:
                raise ValueError("robot target is outside its valid range")
            return target
        normalized = str(target).strip().lower()
        if normalized in ("all", "everyone", "todos", "broadcast"):
            return BROADCAST_ROBOT_ID
        if normalized.isdigit():
            return self.resolve_target(int(normalized))
        started_at = ticks_ms()
        while normalized not in self._directory and ticks_diff(ticks_ms(), started_at) < 3000:
            self.update()
            sleep_ms(10)
        if normalized in self._directory:
            return self._directory[normalized]
        raise ValueError("unknown robot alias: " + str(target))

    def send(self, channel, value, target=BROADCAST_ROBOT_ID, mode="latest"):
        if self._started:
            self.node.poll()
        if not self.wait_until_ready():
            raise RuntimeError("team communication handshake timed out")
        target_id = self.resolve_target(target)
        _, payload = encode_typed_value(channel, value)
        if mode == "latest":
            flags = FLAG_LATEST_ONLY
            ttl_ms = 250
        elif mode == "event":
            flags = FLAG_ACK_REQUIRED if target_id != BROADCAST_ROBOT_ID else 0
            ttl_ms = 2000
        else:
            raise ValueError("message mode must be 'latest' or 'event'")
        return self.node.send(target_id, TOPIC_EDUCATIONAL_DATA, payload, flags=flags, ttl_ms=ttl_ms)

    def broadcast(self, channel, value, mode="latest"):
        return self.send(channel, value, BROADCAST_ROBOT_ID, mode)

    def has_message(self, channel):
        self.update()
        channel, _ = _normalize_channel(channel)
        return channel in self._fresh

    def has_message_from(self, channel, source):
        self.update()
        channel, _ = _normalize_channel(channel)
        return (channel, self.resolve_target(source)) in self._source_fresh

    def read(self, channel, default=None):
        self.update()
        channel, _ = _normalize_channel(channel)
        if channel not in self._mailboxes:
            return default
        self._fresh.discard(channel)
        return self._mailboxes[channel]

    def read_from(self, channel, source, default=None):
        self.update()
        channel, _ = _normalize_channel(channel)
        key = (channel, self.resolve_target(source))
        if key not in self._source_mailboxes:
            return default
        self._source_fresh.discard(key)
        return self._source_mailboxes[key]

    def sender(self, channel):
        self.update()
        channel, _ = _normalize_channel(channel)
        return self._last_sender.get(channel)

    def sender_name(self, channel):
        sender_id = self.sender(channel)
        if sender_id is None:
            return None
        return self.robot_name(sender_id)

    def _store(self, channel, value, sender):
        if channel not in self._mailboxes and len(self._mailboxes) >= self.maximum_channels:
            oldest = next(iter(self._mailboxes))
            del self._mailboxes[oldest]
            self._fresh.discard(oldest)
            self._last_sender.pop(oldest, None)
        self._mailboxes[channel] = value
        self._last_sender[channel] = sender
        self._fresh.add(channel)
        source_key = (channel, sender)
        if source_key not in self._source_mailboxes and len(self._source_mailboxes) >= self.maximum_channels * 4:
            oldest_source = next(iter(self._source_mailboxes))
            del self._source_mailboxes[oldest_source]
            self._source_fresh.discard(oldest_source)
        self._source_mailboxes[source_key] = value
        self._source_fresh.add(source_key)

    def _on_educational_message(self, message):
        try:
            channel, value = decode_typed_value(message.payload)
            self._store(channel, value, message.source_robot_id)
        except (ValueError, TypeError, UnicodeError):
            self.node.diagnostics.invalid_packets += 1

    def _on_directory_message(self, message):
        payload = bytes(message.payload)
        if len(payload) < 1:
            return
        entry_count = payload[0]
        offset = 1
        for _ in range(entry_count):
            if offset + 3 > len(payload):
                return
            robot_id = struct.unpack("<H", payload[offset:offset + 2])[0]
            alias_length = payload[offset + 2]
            offset += 3
            if alias_length == 0 or offset + alias_length > len(payload):
                return
            try:
                alias_text = payload[offset:offset + alias_length].decode("utf-8").strip()
            except UnicodeError:
                return
            offset += alias_length
            if alias_text:
                self._directory[alias_text.lower()] = robot_id
                self._robot_names[robot_id] = alias_text

    def _on_emotion_message(self, message):
        payload = bytes(message.payload)
        if len(payload) == 4:
            self._store("emotion", payload[0], message.source_robot_id)


_default_team = None


def get_default_team():
    global _default_team
    if _default_team is None:
        _default_team = TeamLink()
    return _default_team
