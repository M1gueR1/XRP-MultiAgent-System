import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import unittest

from MultiAgentLib.codec import decode_message, encode_packet
from MultiAgentLib.message import MultiAgentMessage
from MultiAgentLib.native_codec import NativeCodecBackend, NativeXPPStreamParser
from MultiAgentLib.node import MultiAgentNode, ticks_ms
from MultiAgentLib.stream_parser import XPPStreamParser
from MultiAgentLib.transport import MultiAgentTransport


class PythonTestDouble:
    """Interface double only; the Docker contract separately executes real C."""
    @staticmethod
    def api_version():
        return 1

    @staticmethod
    def encode_packet(version, kind, flags, source, target, sequence, topic, ttl, payload):
        return encode_packet(MultiAgentMessage(kind, source, target, sequence, topic, ttl, payload, flags, version))

    @staticmethod
    def decode_message(data):
        m = decode_message(data)
        return (m.protocol_version, m.kind, m.flags, m.source_robot_id, m.target_robot_id,
                m.sequence, m.topic_id, m.ttl_ms, m.payload)

    @staticmethod
    def parse_xpp(data, maximum):
        parser = XPPStreamParser(maximum)
        frames = parser.feed(data)
        return frames, bytes(parser.buffer), parser.discarded_bytes, parser.invalid_packets, parser.overflows


class NativeCodecIntegrationTests(unittest.TestCase):
    def test_default_node_never_imports_native_module(self):
        node = MultiAgentNode('default', transport=MultiAgentTransport(writer=lambda data: None))
        self.assertIsNone(node._codec_backend)
        self.assertIsInstance(node._parser, XPPStreamParser)
        self.assertNotIn('xrp_comm_native', sys.modules)

    def test_missing_module_fails_visibly_when_explicitly_requested(self):
        with self.assertRaises(ImportError):
            NativeCodecBackend()

    def test_wrong_api_fails_before_a_node_can_start(self):
        class WrongApi(PythonTestDouble):
            @staticmethod
            def api_version():
                return 2
        with self.assertRaises(RuntimeError):
            NativeCodecBackend(WrongApi())

    def test_wire_self_test_rejects_incorrect_native_module(self):
        class Broken(PythonTestDouble):
            @staticmethod
            def encode_packet(*_args):
                return b'wrong'
        with self.assertRaises(RuntimeError):
            NativeCodecBackend(Broken())

    def test_decode_self_test_rejects_incorrect_native_module(self):
        class Broken(PythonTestDouble):
            @staticmethod
            def decode_message(data):
                fields = list(PythonTestDouble.decode_message(data))
                fields[5] = 0
                return fields
        with self.assertRaises(RuntimeError):
            NativeCodecBackend(Broken())

    def test_native_parser_fragmentation_overflow_and_reset_keep_counters(self):
        parser = NativeXPPStreamParser(PythonTestDouble(), 300)
        packet = encode_packet(MultiAgentMessage(0x10, 1, 2, 1, payload=b'hello'))
        self.assertEqual(parser.feed(packet[:3]), [])
        self.assertEqual(parser.feed(packet[3:]), [packet])
        parser.feed(bytes(1000))
        self.assertEqual(parser.overflows, 1)
        self.assertEqual(parser.discarded_bytes, 1000)
        parser.reset()
        self.assertEqual(parser.buffer, b'')
        self.assertEqual(parser.overflows, 1)

    def test_parser_minimum_capacity_is_enforced(self):
        with self.assertRaises(ValueError):
            NativeXPPStreamParser(PythonTestDouble(), 260)

    def test_native_backend_retains_normal_node_readiness_and_duplicate_checks(self):
        writes = []
        transport = MultiAgentTransport(writer=writes.append)
        backend = NativeCodecBackend(PythonTestDouble())
        node = MultiAgentNode('explicit', transport=transport, codec_backend=backend)
        node.started = True
        node.robot_id = 1
        node._last_hello_ms = node._last_heartbeat_ms = ticks_ms()
        ping = encode_packet(MultiAgentMessage(0x20, 0, 1, 9, payload=b'\x01\x00'))
        transport.inject_received(ping)
        node.poll()
        self.assertEqual(writes, [])
        node.ready = True
        transport.inject_received(ping)
        node.poll()
        transport.inject_received(ping)
        node.poll()
        self.assertEqual(len(writes), 1)
        self.assertEqual(node.diagnostics.duplicate_messages, 1)
        self.assertEqual(decode_message(writes[0][4:-2]).kind, 0x21)

    def test_capability_script_is_runnable_without_native_module_or_robot(self):
        path = Path(__file__).parents[1] / 'XRPExamples/native_comm_capabilities.py'
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            runpy.run_path(str(path), run_name='__main__')
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[0], 'NATIVE_CAPABILITIES_BEGIN')
        report = json.loads(lines[1])
        self.assertFalse(report['native_module_imported'])
        self.assertIsNone(report['hardware_identity'])
        self.assertIsNone(report['mpy_raw'])
        self.assertNotIn('xrp_comm_native', sys.modules)


if __name__ == '__main__':
    unittest.main()
