import unittest

from MultiAgentLib.codec import decode_message, decode_xpp, encode_message, encode_packet
from MultiAgentLib.constants import (
    FLAG_ACK_REQUIRED,
    FLAG_RELAYED,
    KIND_DATA,
    MAX_APPLICATION_PAYLOAD,
    PROTOCOL_VERSION,
    XPP_MULTI_AGENT,
)
from MultiAgentLib.message import MultiAgentMessage
from MultiAgentLib.stream_parser import XPPStreamParser
from MultiAgentLib.node import MultiAgentNode, ticks_ms
from MultiAgentLib.transport import MultiAgentTransport
from MultiAgentLib.team import TeamLink, decode_typed_value, encode_typed_value


class MultiAgentCodecTests(unittest.TestCase):
    def example(self, payload=b"\xDE\xAD"):
        return MultiAgentMessage(
            KIND_DATA,
            0x1234,
            0xABCD,
            0x0102,
            0x0304,
            0x0506,
            payload,
            FLAG_ACK_REQUIRED | FLAG_RELAYED,
            PROTOCOL_VERSION,
        )

    def test_typescript_golden_bytes_match(self):
        expected = bytes((
            0x01, 0x10, 0x09, 0x34, 0x12, 0xCD, 0xAB, 0x02,
            0x01, 0x04, 0x03, 0x06, 0x05, 0x02, 0xDE, 0xAD,
        ))
        self.assertEqual(encode_message(self.example()), expected)

    def test_maximum_payload_round_trip(self):
        original = self.example(bytes((0xA5,)) * MAX_APPLICATION_PAYLOAD)
        packet = encode_packet(original)
        message_type, payload = decode_xpp(packet)
        self.assertEqual(message_type, XPP_MULTI_AGENT)
        decoded = decode_message(payload)
        self.assertEqual(decoded.payload, original.payload)

    def test_oversized_payload_rejected(self):
        with self.assertRaises(ValueError):
            encode_message(self.example(bytes(221)))

    def test_fragmentation_resync_and_bounded_buffer(self):
        packet = encode_packet(self.example())
        parser = XPPStreamParser(300)
        found = []
        for byte in packet:
            found.extend(parser.feed(bytes((byte,))))
        self.assertEqual(found, [packet])
        parser.feed(bytes(1000))
        self.assertLessEqual(len(parser.buffer), 300)
        self.assertGreater(parser.overflows, 0)

    def test_robot_reliable_send_retries_are_bounded(self):
        writes = []
        transport = MultiAgentTransport(writer=lambda data: writes.append(bytes(data)))
        node = MultiAgentNode(
            "reliable-test",
            transport=transport,
            acknowledgement_timeout_ms=-1,
            maximum_retries=2,
        )
        node.started = True
        node.ready = True
        node.robot_id = 1
        node._last_hello_ms = ticks_ms()
        node._last_heartbeat_ms = ticks_ms()
        node.send(2, 1, b"event", flags=FLAG_ACK_REQUIRED, ttl_ms=2000)
        node.poll()
        node.poll()
        node.poll()
        self.assertEqual(len(writes), 3)
        self.assertEqual(node.diagnostics.dropped_messages, 1)

    def test_usb_transport_reads_nonblocking_serial_bytes(self):
        class Reader:
            def __init__(self, data):
                self.data = bytearray(data)

            def read(self, count):
                result = bytes(self.data[:count])
                del self.data[:count]
                return result

        class Poller:
            def __init__(self, reader):
                self.reader = reader

            def poll(self, _timeout):
                return [(0, 1)] if self.reader.data else []

        packet = b"\xaa\x55\x30\x00\x55\xaa"
        reader = Reader(b"__XRPMA__:" + packet.hex().encode("ascii") + b"\n")
        transport = MultiAgentTransport()
        transport._usb_reader = reader
        transport._usb_poller = Poller(reader)
        self.assertEqual(transport.read_available(), packet)
        self.assertIsNone(transport.read_available())

    def test_educational_values_round_trip(self):
        values = (None, True, -42, 3.5, "hello XRP", (12.25, -4.5))
        for value in values:
            channel, payload = encode_typed_value("Distance", value)
            decoded_channel, decoded_value = decode_typed_value(payload)
            self.assertEqual(channel, "distance")
            self.assertEqual(decoded_channel, "distance")
            if isinstance(value, tuple):
                self.assertAlmostEqual(decoded_value[0], value[0], places=4)
                self.assertAlmostEqual(decoded_value[1], value[1], places=4)
            elif isinstance(value, float):
                self.assertAlmostEqual(decoded_value, value, places=4)
            else:
                self.assertEqual(decoded_value, value)

    def test_team_mailbox_keeps_latest_value_and_sender(self):
        transport = MultiAgentTransport(writer=lambda _data: None)
        node = MultiAgentNode("mailbox-test", transport=transport)
        team = TeamLink(node=node)
        _, first = encode_typed_value("distance", 12)
        _, second = encode_typed_value("distance", 7)
        message = self.example(first)
        message.source_robot_id = 2
        team._on_educational_message(message)
        message.payload = second
        team._on_educational_message(message)
        self.assertTrue(team.has_message("distance"))
        self.assertEqual(team.read("distance"), 7)
        self.assertEqual(team.sender("distance"), 2)
        self.assertTrue(team.has_message_from("distance", 2))
        self.assertEqual(team.read_from("distance", 2), 7)
        self.assertFalse(team.has_message_from("distance", 2))
        self.assertFalse(team.has_message("distance"))

    def test_team_directory_resolves_robot_aliases(self):
        transport = MultiAgentTransport(writer=lambda _data: None)
        node = MultiAgentNode("directory-test", transport=transport)
        team = TeamLink(node=node)
        alias = b"Blue XRP"
        payload = bytes((1, 2, 0, len(alias))) + alias
        message = self.example(payload)
        team._on_directory_message(message)
        self.assertEqual(team.resolve_target("blue xrp"), 2)


if __name__ == "__main__":
    unittest.main()
