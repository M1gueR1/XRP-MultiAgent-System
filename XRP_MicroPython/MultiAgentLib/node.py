try:
    import time
    ticks_ms = time.ticks_ms
    ticks_diff = time.ticks_diff
except AttributeError:
    import time
    ticks_ms = lambda: int(time.time() * 1000)
    ticks_diff = lambda newer, older: newer - older

import struct

from .codec import decode_message, decode_xpp, encode_packet
from .constants import (
    BROADCAST_ROBOT_ID,
    COORDINATOR_ID,
    FLAG_ACK_REQUIRED,
    KIND_ACK,
    KIND_DATA,
    KIND_HEARTBEAT,
    KIND_HELLO,
    KIND_HELLO_ACK,
    KIND_PING,
    KIND_PONG,
    MAX_APPLICATION_PAYLOAD,
    PROTOCOL_VERSION,
    UNASSIGNED_ROBOT_ID,
    XPP_MULTI_AGENT,
)
from .diagnostics import MultiAgentDiagnostics
from .message import MultiAgentMessage
from .stream_parser import XPPStreamParser
from .transport import MultiAgentTransport


class MultiAgentNode:
    def __init__(
        self,
        hardware_identity,
        transport=None,
        maximum_received_messages=32,
        maximum_recent_messages=64,
        maximum_pending_acks=16,
        acknowledgement_timeout_ms=500,
        maximum_retries=2,
    ):
        identity_bytes = str(hardware_identity).encode("utf-8")
        if len(identity_bytes) > 32:
            raise ValueError("hardware identity cannot exceed 32 UTF-8 bytes")
        self.hardware_identity = str(hardware_identity)
        self.transport = transport or MultiAgentTransport()
        self.maximum_received_messages = maximum_received_messages
        self.maximum_recent_messages = maximum_recent_messages
        self.maximum_pending_acks = maximum_pending_acks
        self.acknowledgement_timeout_ms = acknowledgement_timeout_ms
        self.maximum_retries = maximum_retries
        self.robot_id = UNASSIGNED_ROBOT_ID
        self.heartbeat_interval_ms = 1000
        self.sequence = 0
        self.started = False
        self.ready = False
        self._last_hello_ms = 0
        self._last_heartbeat_ms = 0
        self._parser = XPPStreamParser()
        self._received = []
        self._recent = []
        self._callbacks = {}
        self._pending_acks = []
        self.diagnostics = MultiAgentDiagnostics()

    def start(self, attach_existing_ble=True):
        if attach_existing_ble and not self.transport.is_attached():
            self.transport.attach_default()
        self.started = True
        self._send_hello()

    def poll(self):
        if not self.started:
            return 0
        processed = 0
        chunk = self.transport.read_available()
        while chunk is not None:
            self.diagnostics.bytes_received += len(chunk)
            for packet in self._parser.feed(chunk):
                try:
                    message_type, payload = decode_xpp(packet)
                    if message_type != XPP_MULTI_AGENT:
                        continue
                    message = decode_message(payload)
                    message.arrival_ms = ticks_ms()
                    self._handle_message(message)
                    processed += 1
                except (ValueError, TypeError, IndexError):
                    self.diagnostics.invalid_packets += 1
            chunk = self.transport.read_available()

        now = ticks_ms()
        if not self.ready and ticks_diff(now, self._last_hello_ms) >= 1000:
            self._send_hello()
        # Periodic identity refresh lets a reconnected laptop perform a fresh
        # handshake without resetting or interrupting this program.
        if self.ready and ticks_diff(now, self._last_hello_ms) >= 5000:
            self._send_hello()
        if self.ready and ticks_diff(now, self._last_heartbeat_ms) >= self.heartbeat_interval_ms:
            self._last_heartbeat_ms = now
            try:
                self.send_control(KIND_HEARTBEAT, COORDINATOR_ID, ttl_ms=self.heartbeat_interval_ms * 3)
            except (OSError, RuntimeError):
                pass
        self._poll_reliable_retries(now)
        self.diagnostics.maximum_receive_depth = max(
            self.diagnostics.maximum_receive_depth,
            len(self._received),
        )
        return processed

    def receive(self):
        if not self._received:
            return None
        return self._received.pop(0)

    def on_topic(self, topic_id, callback):
        if not callable(callback):
            raise TypeError("topic callback must be callable")
        self._callbacks[topic_id] = callback

    def send(self, target_robot_id, topic_id, payload, flags=0, ttl_ms=0):
        if not self.ready:
            raise RuntimeError("multi-agent handshake has not completed")
        payload = bytes(payload)
        if len(payload) > MAX_APPLICATION_PAYLOAD:
            raise ValueError("application payload exceeds 220 bytes")
        message = MultiAgentMessage(
            KIND_DATA,
            self.robot_id,
            target_robot_id,
            self._next_sequence(),
            topic_id,
            ttl_ms,
            payload,
            flags,
        )
        if flags & FLAG_ACK_REQUIRED and len(self._pending_acks) >= self.maximum_pending_acks:
            raise RuntimeError("reliable event queue is full")
        self._write(message)
        if flags & FLAG_ACK_REQUIRED:
            self._pending_acks.append([
                self.robot_id,
                message.sequence,
                message,
                ticks_ms(),
                0,
            ])
        return message.sequence

    def broadcast(self, topic_id, payload, flags=0, ttl_ms=0):
        return self.send(BROADCAST_ROBOT_ID, topic_id, payload, flags, ttl_ms)

    def send_control(self, kind, target_robot_id, payload=b"", topic_id=0, ttl_ms=0, flags=0):
        message = MultiAgentMessage(
            kind,
            self.robot_id,
            target_robot_id,
            self._next_sequence(),
            topic_id,
            ttl_ms,
            payload,
            flags,
        )
        self._write(message)
        return message.sequence

    def _send_hello(self):
        identity = self.hardware_identity.encode("utf-8")
        payload = bytes((PROTOCOL_VERSION, 1, 0, MAX_APPLICATION_PAYLOAD))
        payload += struct.pack("<H", 0x000F)
        payload += bytes((len(identity), 0)) + identity
        message = MultiAgentMessage(
            KIND_HELLO,
            UNASSIGNED_ROBOT_ID,
            COORDINATOR_ID,
            self._next_sequence(),
            payload=payload,
            ttl_ms=5000,
        )
        try:
            self._write(message)
        except (OSError, RuntimeError):
            return
        self._last_hello_ms = ticks_ms()

    def _handle_message(self, message):
        self.diagnostics.messages_received += 1
        if message.kind == KIND_HELLO_ACK:
            if len(message.payload) != 7:
                self.diagnostics.invalid_packets += 1
                return
            assigned, coordinator, heartbeat = struct.unpack("<HHH", message.payload[:6])
            if coordinator != COORDINATOR_ID or message.payload[6] != PROTOCOL_VERSION:
                self.diagnostics.invalid_packets += 1
                return
            self.robot_id = assigned
            self.heartbeat_interval_ms = heartbeat
            self.ready = True
            return
        if not self.ready or message.target_robot_id not in (self.robot_id, BROADCAST_ROBOT_ID):
            return
        duplicate_key = (message.source_robot_id, message.sequence)
        if duplicate_key in self._recent:
            self.diagnostics.duplicate_messages += 1
            return
        self._recent.append(duplicate_key)
        if len(self._recent) > self.maximum_recent_messages:
            self._recent.pop(0)
        if message.ttl_ms and ticks_diff(ticks_ms(), message.arrival_ms) > message.ttl_ms:
            self.diagnostics.stale_messages += 1
            return
        if message.kind == KIND_PING:
            self.send_control(KIND_PONG, message.source_robot_id, message.payload, ttl_ms=2000)
            return
        if message.kind == KIND_ACK:
            if len(message.payload) != 4:
                self.diagnostics.invalid_packets += 1
                return
            acknowledged_source, acknowledged_sequence = struct.unpack("<HH", message.payload)
            for index in range(len(self._pending_acks) - 1, -1, -1):
                pending = self._pending_acks[index]
                if pending[0] == acknowledged_source and pending[1] == acknowledged_sequence:
                    self._pending_acks.pop(index)
                    break
            return
        if message.kind == KIND_DATA:
            if message.flags & FLAG_ACK_REQUIRED:
                ack = struct.pack("<HH", message.source_robot_id, message.sequence)
                self.send_control(KIND_ACK, message.source_robot_id, ack, message.topic_id, 2000)
            if len(self._received) >= self.maximum_received_messages:
                self._received.pop(0)
                self.diagnostics.dropped_messages += 1
            self._received.append(message)
            callback = self._callbacks.get(message.topic_id)
            if callback is not None:
                callback(message)

    def _write(self, message):
        packet = encode_packet(message)
        self.transport.write(packet)
        self.diagnostics.messages_sent += 1
        self.diagnostics.bytes_sent += len(packet)

    def _poll_reliable_retries(self, now):
        for index in range(len(self._pending_acks) - 1, -1, -1):
            pending = self._pending_acks[index]
            if ticks_diff(now, pending[3]) < self.acknowledgement_timeout_ms:
                continue
            if pending[4] >= self.maximum_retries:
                self._pending_acks.pop(index)
                self.diagnostics.dropped_messages += 1
                continue
            try:
                self._write(pending[2])
                pending[3] = now
                pending[4] += 1
            except (OSError, RuntimeError):
                pending[3] = now

    def _next_sequence(self):
        value = self.sequence
        self.sequence = (self.sequence + 1) & 0xFFFF
        return value
