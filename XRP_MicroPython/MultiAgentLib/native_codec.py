"""Explicit per-node experiment; importing this file never imports native code."""

from .codec import encode_packet
from .constants import KNOWN_KINDS, MAX_RECEIVE_BUFFER, PROTOCOL_VERSION
from .message import MultiAgentMessage


class NativeXPPStreamParser:
    def __init__(self, module, maximum_buffer_size=MAX_RECEIVE_BUFFER):
        if maximum_buffer_size < 261:
            raise ValueError("receive buffer must fit a maximum XPP packet")
        self.module = module
        self.maximum_buffer_size = maximum_buffer_size
        self.buffer = bytearray()
        self.discarded_bytes = 0
        self.invalid_packets = 0
        self.overflows = 0

    def reset(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        frames, remaining, discarded, invalid, overflows = self.module.parse_xpp(
            self.buffer, self.maximum_buffer_size
        )
        self.buffer = bytearray(remaining)
        self.discarded_bytes += discarded
        self.invalid_packets += invalid
        self.overflows += overflows
        return frames


class NativeCodecBackend:
    def __init__(self, module=None):
        if module is None:
            import xrp_comm_native
            module = xrp_comm_native
        if module.api_version() != 1:
            raise RuntimeError("unsupported native communication module API")
        self.module = module
        # A small ABI/wire check fails before a node can start sending anything.
        probe = MultiAgentMessage(0x20, 0, 1, 0x1234, payload=b"\x00\xff")
        expected = encode_packet(probe)
        if self.encode_packet(probe) != expected:
            raise RuntimeError("native communication module failed its wire-format self-test")
        decoded = self.decode_message(expected[4:-2])
        if decoded.sequence != probe.sequence or decoded.payload != probe.payload:
            raise RuntimeError("native communication module failed its decode self-test")

    def create_parser(self):
        return NativeXPPStreamParser(self.module)

    def encode_packet(self, message):
        if message.protocol_version != PROTOCOL_VERSION:
            raise ValueError("unsupported multi-agent protocol version")
        if message.kind not in KNOWN_KINDS:
            raise ValueError("unknown multi-agent message kind")
        return self.module.encode_packet(
            message.protocol_version, message.kind, message.flags,
            message.source_robot_id, message.target_robot_id, message.sequence,
            message.topic_id, message.ttl_ms, bytes(message.payload),
        )

    def decode_message(self, data):
        version, kind, flags, source, target, sequence, topic, ttl, payload = self.module.decode_message(data)
        return MultiAgentMessage(kind, source, target, sequence, topic, ttl, payload, flags, version)
