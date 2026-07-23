import struct

from .constants import (
    BROADCAST_ROBOT_ID,
    HEADER_LENGTH,
    KNOWN_KINDS,
    MAX_APPLICATION_PAYLOAD,
    MAX_XPP_PAYLOAD,
    PROTOCOL_VERSION,
    XPP_END,
    XPP_MULTI_AGENT,
    XPP_START,
)
from .message import MultiAgentMessage


def _uint(name, value, maximum):
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(name + " must be an integer")
    if value < 0 or value > maximum:
        raise ValueError(name + " is outside its unsigned range")
    return value


def encode_message(message):
    if message.protocol_version != PROTOCOL_VERSION:
        raise ValueError("unsupported multi-agent protocol version")
    if message.kind not in KNOWN_KINDS:
        raise ValueError("unknown multi-agent message kind")
    _uint("flags", message.flags, 255)
    _uint("source_robot_id", message.source_robot_id, BROADCAST_ROBOT_ID - 1)
    _uint("target_robot_id", message.target_robot_id, BROADCAST_ROBOT_ID)
    _uint("sequence", message.sequence, 65535)
    _uint("topic_id", message.topic_id, 65535)
    _uint("ttl_ms", message.ttl_ms, 65535)
    payload = bytes(message.payload)
    if len(payload) > MAX_APPLICATION_PAYLOAD:
        raise ValueError("application payload exceeds 220 bytes")
    header = struct.pack(
        "<BBBHHHHHB",
        message.protocol_version,
        message.kind,
        message.flags,
        message.source_robot_id,
        message.target_robot_id,
        message.sequence,
        message.topic_id,
        message.ttl_ms,
        len(payload),
    )
    return header + payload


def decode_message(data):
    if len(data) < HEADER_LENGTH:
        raise ValueError("multi-agent envelope is shorter than its header")
    fields = struct.unpack("<BBBHHHHHB", data[:HEADER_LENGTH])
    payload_length = fields[8]
    if payload_length > MAX_APPLICATION_PAYLOAD:
        raise ValueError("application payload exceeds 220 bytes")
    if len(data) != HEADER_LENGTH + payload_length:
        raise ValueError("application payload length mismatch")
    message = MultiAgentMessage(
        fields[1],
        fields[3],
        fields[4],
        fields[5],
        fields[6],
        fields[7],
        data[HEADER_LENGTH:],
        fields[2],
        fields[0],
    )
    # Reuse the encoder's complete validation without retaining its result.
    encode_message(message)
    return message


def encode_xpp(payload, message_type=XPP_MULTI_AGENT):
    payload = bytes(payload)
    _uint("message_type", message_type, 255)
    if len(payload) > MAX_XPP_PAYLOAD:
        raise ValueError("XPP payload exceeds 255 bytes")
    return XPP_START + bytes((message_type, len(payload))) + payload + XPP_END


def decode_xpp(packet):
    if len(packet) < 6:
        raise ValueError("XPP packet is too short")
    if packet[:2] != XPP_START or packet[-2:] != XPP_END:
        raise ValueError("invalid XPP framing")
    if len(packet) != packet[3] + 6:
        raise ValueError("invalid XPP payload length")
    return packet[2], bytes(packet[4:-2])


def encode_packet(message):
    return encode_xpp(encode_message(message))

