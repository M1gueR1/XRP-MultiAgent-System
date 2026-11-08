"""Execute with MicroPython and the actual compiled native .mpy on sys.path."""

from MultiAgentLib.codec import encode_packet, decode_message
from MultiAgentLib.constants import KNOWN_KINDS
from MultiAgentLib.message import MultiAgentMessage
from MultiAgentLib.native_codec import NativeCodecBackend
from MultiAgentLib.stream_parser import XPPStreamParser
from MultiAgentLib.node import MultiAgentNode, ticks_ms
from MultiAgentLib.transport import MultiAgentTransport

native = NativeCodecBackend()
cases = 0


def same_message(left, right):
    for name in MultiAgentMessage.__slots__:
        assert getattr(left, name) == getattr(right, name), name


for kind in KNOWN_KINDS:
    for size in (0, 1, 2, 32, 220):
        payload = bytes(i % 256 for i in range(size))
        message = MultiAgentMessage(kind, 65534, 65535, 65535, 65535, 65535, payload, 255)
        packet = encode_packet(message)
        assert native.encode_packet(message) == packet
        same_message(native.decode_message(packet[4:-2]), decode_message(packet[4:-2]))
        cases += 1

message = MultiAgentMessage(0x10, 1, 2, 123, payload=b'\xaa\x55\x55\xaa')
packet = encode_packet(message)
for field, value, error in (
    ('flags', True, TypeError), ('source_robot_id', 65535, ValueError),
    ('target_robot_id', -1, ValueError), ('sequence', 65536, ValueError),
    ('topic_id', 2 ** 80, ValueError), ('ttl_ms', 1.5, TypeError),
    ('payload', bytes(221), ValueError), ('protocol_version', 2, ValueError), ('kind', 0xff, ValueError),
):
    original = getattr(message, field)
    setattr(message, field, value)
    try:
        native.encode_packet(message)
        raise AssertionError('accepted invalid ' + field)
    except error:
        pass
    setattr(message, field, original)
    cases += 1

for size in range(len(packet) - 6):
    try:
        native.decode_message(packet[4:-2][:size])
        raise AssertionError('accepted a truncated envelope')
    except ValueError:
        pass
    cases += 1


def check_stream(chunks):
    python_parser = XPPStreamParser(300)
    native_parser = native.create_parser()
    native_parser.maximum_buffer_size = 300
    for chunk in chunks:
        assert python_parser.feed(chunk) == native_parser.feed(chunk)
        assert python_parser.buffer == native_parser.buffer
        assert python_parser.discarded_bytes == native_parser.discarded_bytes
        assert python_parser.invalid_packets == native_parser.invalid_packets
        assert python_parser.overflows == native_parser.overflows
    python_parser.reset()
    native_parser.reset()
    assert python_parser.buffer == native_parser.buffer


check_stream([b'', b'noise\xaa', packet, bytes(1000), packet[:3], packet[3:]])
check_stream([bytes((value,)) for value in packet * 4])
check_stream([b'\xaa\x55\x30\x00\x00\x00' + packet * 3])
check_stream([b'\xaa\x55\xff\xff' + bytes(255) + b'\x55\xaa'])
seed = 42
for test in range(1000):
    chunks = []
    for index in range(5):
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        noise = bytes(((seed >> (offset % 16)) & 255) for offset in range(seed % 39))
        chunks.append(noise + packet[:seed % len(packet)])
        chunks.append(packet[seed % len(packet):])
    check_stream(chunks)
    cases += 1

# Same real node behavior, including normal identity/readiness/duplicate checks.
def node_replies(backend):
    writes = []
    transport = MultiAgentTransport(writer=lambda data: writes.append(data))
    node = MultiAgentNode('native-contract', transport=transport, codec_backend=backend)
    node.started = True
    node.ready = True
    node.robot_id = 1
    node._last_hello_ms = node._last_heartbeat_ms = ticks_ms()
    ping = MultiAgentMessage(0x20, 0, 1, 17, payload=b'\x01\x00')
    transport.inject_received(encode_packet(ping))
    node.poll()
    transport.inject_received(encode_packet(ping))
    node.poll()
    assert node.diagnostics.duplicate_messages == 1
    return writes

assert node_replies(None) == node_replies(native)
assert len(node_replies(native)) == 1
print('NATIVE_CONTRACT_OK:', cases, 'wire/validation/parser cases plus real-node PING parity')
