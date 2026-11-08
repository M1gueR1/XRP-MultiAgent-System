import struct
import unittest
import io
from pathlib import Path
from unittest.mock import patch

from XRPExamples.ble_30hz_receiver import RateReceiver, PollBudgetTransport, ReceiveDiagnostics, MeasuredReader, existing_ble_uart
from MultiAgentLib.transport import MultiAgentTransport
from MultiAgentLib.node import MultiAgentNode
from MultiAgentLib.codec import encode_packet, decode_xpp, decode_message
from MultiAgentLib.message import MultiAgentMessage
from MultiAgentLib.constants import KIND_DATA, KIND_HEARTBEAT


def packet(op, run_id=100, body=b""):
    return struct.pack("<BBI", 1, op, run_id) + body


class RateReceiverTests(unittest.TestCase):
    def test_example_source_cannot_trigger_the_firmware_restart_during_ble_upload(self):
        source = (Path(__file__).resolve().parents[1] / "XRPExamples" / "ble_30hz_receiver.py").read_bytes()
        self.assertNotIn(b"##XRP" + b"STOP##", source)

    def test_existing_uart_inspection_restores_terminal_and_rejects_unknown_stream(self):
        class BLEUART:
            _rx_buffer = bytearray()
            def any(self):
                return len(self._rx_buffer)
            def read(self, amount):
                return b""
        class BLEUARTStream:
            _uart = BLEUART()
        stream = BLEUARTStream()
        state = [stream]
        def duplicate(value, index):
            self.assertEqual(index, 0)
            previous, state[0] = state[0], value
            return previous
        self.assertIs(existing_ble_uart(duplicate), stream._uart)
        self.assertIs(state[0], stream)
        unknown = object()
        state[0] = unknown
        with self.assertRaisesRegex(RuntimeError, "No compatible"):
            existing_ble_uart(duplicate)
        self.assertIs(state[0], unknown)
        state[0] = None
        with self.assertRaises(RuntimeError):
            existing_ble_uart(duplicate)
        self.assertIsNone(state[0])

    def buffered_transport(self, data=b""):
        class UART:
            def __init__(self):
                self._rx_buffer = bytearray(data)
                self.read_sizes = []
            def any(self):
                return len(self._rx_buffer)
            def read(self, amount):
                if not self._rx_buffer or amount > len(self._rx_buffer):
                    raise AssertionError("attempted a potentially blocking read")
                self.read_sizes.append(amount)
                value = self._rx_buffer[:amount]
                del self._rx_buffer[:amount]
                return value
        d = ReceiveDiagnostics(lambda: self.now * 1000, lambda a, b: a - b)
        t = PollBudgetTransport(writer=lambda data: None, diagnostics=d, buffered_ble=True)
        t._direct_uart = UART()
        t.reader_mode_id = 1
        return t, d

    def test_buffered_reader_uses_three_bounded_reads_for_fragmented_75_byte_frame(self):
        frame = b"__XRPMA__:" + b"ab" * 32 + b"\n"
        t, d = self.buffered_transport(frame)
        t.begin_poll()
        self.assertIsNone(t.read_available())
        self.assertIsNone(t.read_available())
        self.assertEqual(t.read_available(), b"\xab" * 32)
        self.assertIsNone(t.read_available())
        self.assertIsNone(t.read_available())  # poll's four-call budget exhausted
        self.assertEqual(t._direct_uart.read_sizes, [32, 32, 11])
        self.assertEqual(d.values["streamBytes"], 75)
        self.assertEqual(d.values["readCalls"], 3)
        self.assertEqual(d.values["decodedFrames"], 1)

    def test_buffered_reader_preserves_ctrl_c_and_never_reads_empty_input(self):
        t, d = self.buffered_transport()
        t.begin_poll()
        self.assertIsNone(t.read_available())
        self.assertEqual(d.values["readCalls"], 0)
        t._direct_uart._rx_buffer.extend(b"\x03")
        with self.assertRaises(KeyboardInterrupt):
            t.read_available()

    def test_buffered_experiment_rejects_usb_before_attaching_stream(self):
        t = PollBudgetTransport(buffered_ble=True)
        with patch.object(MultiAgentTransport, "attach_existing_stream") as attach:
            with self.assertRaisesRegex(RuntimeError, "not USB"):
                t.attach_existing_stream("USB")
            attach.assert_not_called()

    def test_buffered_frames_arriving_together_remain_ordered_across_polls(self):
        t, d = self.buffered_transport(b"__XRPMA__:aa\n__XRPMA__:bb\n__XRPMA__:cc\n")
        result = []
        while t._direct_uart.any() or t._chunks:
            t.begin_poll()
            for _ in range(4):
                value = t.read_available()
                if value is not None:
                    result.append(value)
        self.assertEqual(result, [b"\xaa", b"\xbb", b"\xcc"])
        self.assertEqual(d.values["droppedChunks"], 0)

    def test_buffered_stream_uses_real_node_decoder_and_preserves_heartbeats(self):
        t, d = self.buffered_transport()
        writes = []
        t._writer = writes.append
        node = MultiAgentNode("buffered-test", transport=t)
        node.started = node.ready = True
        node.robot_id = 1
        receiver = RateReceiver(lambda payload: node.send(0, 0x7F30, payload), lambda: self.now,
                                lambda a, b: a - b, d, lambda: t.reader_mode_id)
        node.on_topic(0x7F30, lambda message: receiver.handle(message.payload))
        def push(payload, sequence):
            wire = encode_packet(MultiAgentMessage(KIND_DATA, 0, 1, sequence, 0x7F30, payload=payload))
            t._direct_uart._rx_buffer.extend(b"__XRPMA__:" + wire.hex().encode() + b"\n")
            while t._direct_uart.any() or t._chunks:
                t.begin_poll()
                node.poll()
                while node.receive() is not None:
                    pass
                receiver.poll()
        with patch("MultiAgentLib.node.ticks_ms", lambda: self.now):
            push(packet(1, body=struct.pack("<HH", 30, 60)), 0)
            for sequence in range(100):
                self.now = sequence * 33
                push(packet(2, body=struct.pack("<Hhh", sequence, 0, 0)), sequence + 1)
            push(packet(3), 101)
        self.assertEqual(receiver.received, 100)
        self.assertEqual(receiver.within, 100)
        self.assertLess(d.values["readCalls"], d.values["streamBytes"] / 10)
        self.assertTrue(any(decode_message(decode_xpp(data)[1]).kind == KIND_HEARTBEAT for data in writes))
        final = decode_message(decode_xpp(writes[-1])[1]).payload
        self.assertEqual(len(final), 89)
        self.assertEqual(final[-2:], b"\x06\x01")
        frozen = final
        self.now += 1001
        receiver.poll()
        self.assertEqual(decode_message(decode_xpp(writes[-1])[1]).payload, frozen)

    def test_lower_rates_keep_final_diagnostics_frozen_and_buffers_bounded(self):
        for hz in (5, 10):
            d = ReceiveDiagnostics(lambda: self.now * 1000, lambda a, b: a - b)
            receiver = RateReceiver(self.sent.append, lambda: self.now, lambda a, b: a - b, d)
            receiver.handle(packet(1, body=struct.pack("<HH", hz, 60)))
            d.values["streamBytes"] = 75 * hz
            for sequence in range(hz):
                receiver.handle(packet(2, body=struct.pack("<Hhh", sequence, 0, 0)))
            receiver.handle(packet(3))
            frozen = self.sent[-1]
            self.assertEqual(len(frozen), 87)
            self.assertEqual(struct.unpack_from("<I", frozen, 35)[0], 75 * hz)
            self.assertEqual(receiver.total, hz * 60)
            d.values["streamBytes"] = 99999
            self.now += 1001
            receiver.poll()
            self.assertEqual(self.sent[-1], frozen)

    def test_measured_stream_retains_fragmented_frames_and_counts_read_cost(self):
        tick = [0]
        def clock():
            tick[0] += 10
            return tick[0]
        d = ReceiveDiagnostics(clock, lambda a, b: a - b)
        transport = PollBudgetTransport(writer=lambda data: None, diagnostics=d)
        data = b"__XRPMA__:010203\n"
        transport._usb_reader = MeasuredReader(io.BytesIO(data), d)
        class Poller:
            def poll(self, timeout):
                return [(0, 1)] if transport._usb_reader.reader.tell() < len(data) else []
        transport._usb_poller = Poller()
        transport.begin_poll()
        self.assertEqual(transport.read_available(), b"\x01\x02\x03")
        self.assertEqual(d.values["streamBytes"], len(data))
        self.assertEqual(d.values["readCalls"], len(data))
        self.assertEqual(d.values["decodedFrames"], 1)
        self.assertGreater(d.values["readUs"], 0)
        self.assertGreater(d.values["decodeUs"], 0)

    def setUp(self):
        self.now = 0
        self.sent = []
        self.receiver = RateReceiver(self.sent.append, lambda: self.now, lambda a, b: a - b)

    def start(self, seconds=60):
        self.receiver.handle(packet(1, body=struct.pack("<HH", 30, seconds)))

    def sample(self, sequence, run_id=100, velocity=0):
        self.receiver.handle(packet(2, run_id, struct.pack("<Hhh", sequence, velocity, 0)))

    def test_full_window_counts_unique_samples_with_bounded_buffers(self):
        self.start()
        for sequence in range(1800):
            self.now = round(sequence * 1000 / 30)
            self.sample(sequence)
        self.receiver.handle(packet(3))
        report = struct.unpack("<BBIBHHHHHHIIIHH", self.sent[-1])
        self.assertEqual(len(self.sent[-1]), 35)
        self.assertEqual(report[3:6], (3, 1800, 1800))
        self.assertEqual(report[-2], 34)
        self.assertEqual(len(self.receiver.seen), 225)
        self.assertEqual(len(self.receiver.gaps), 3598)

    def test_duplicates_wrong_run_out_of_order_and_invalid_do_not_inflate_rate(self):
        self.start(1)
        self.sample(2)
        self.sample(2)
        self.now = 10
        self.sample(1)
        self.sample(3, run_id=101)
        self.sample(4, velocity=1)
        self.sample(30)
        self.assertEqual(self.receiver.received, 2)
        self.assertEqual(self.receiver.duplicates, 1)
        self.assertEqual(self.receiver.out_of_order, 1)
        self.assertEqual(self.receiver.invalid, 2)

    def test_late_arrivals_are_separate_from_nominal_window(self):
        self.start(1)
        self.sample(0)
        self.now = 999
        self.sample(1)
        self.now = 1000
        self.sample(2)
        self.assertEqual(self.receiver.within, 2)
        self.assertEqual(self.receiver.received, 3)

    def test_matching_start_is_idempotent_and_another_run_cannot_reset_active_counters(self):
        self.start(1)
        self.sample(0)
        self.start(1)
        self.receiver.handle(packet(1, 101, struct.pack("<HH", 30, 1)))
        self.assertEqual(self.receiver.received, 1)
        self.assertEqual(self.receiver.run_id, 100)

    def test_cancel_or_lost_stop_expires_and_new_run_can_start(self):
        self.start(1)
        self.now = 16000
        self.receiver.poll()
        self.assertEqual(self.receiver.phase, 3)
        self.receiver.handle(packet(1, 101, struct.pack("<HH", 30, 1)))
        self.assertEqual(self.receiver.phase, 1)
        self.assertEqual(self.receiver.run_id, 101)

    def test_reports_are_periodic_not_per_sample_and_final_counters_stay_frozen(self):
        self.start(1)
        for sequence in range(30):
            self.sample(sequence)
        self.assertEqual(len(self.sent), 1)
        self.now = 1001
        self.receiver.poll()
        self.assertEqual(len(self.sent), 2)
        self.receiver.handle(packet(3))
        self.sample(0)
        self.assertEqual(self.receiver.received, 30)

    def test_malformed_and_unsupported_start_cannot_arm_the_receiver(self):
        for payload in [b"", packet(1), packet(1, body=struct.pack("<HH", 60, 60)),
                        packet(1, body=struct.pack("<HH", 30, 61)), packet(1, body=struct.pack("<HH", 30, 0))]:
            self.receiver.handle(payload)
        self.assertEqual(self.receiver.phase, 0)

    def test_busy_ble_report_is_retried_without_losing_received_samples(self):
        def busy(_data):
            raise OSError("indication busy")
        self.receiver.send = busy
        self.start(1)
        self.sample(0)
        self.receiver.handle(packet(3))
        self.assertTrue(self.receiver.report_pending)
        self.assertEqual(self.receiver.received, 1)
        self.receiver.send = self.sent.append
        self.now = 1001
        self.receiver.poll()
        self.assertFalse(self.receiver.report_pending)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][6], 3)

    def test_abandoned_setup_can_be_replaced_without_waiting_for_75_second_expiry(self):
        self.start()
        self.receiver.handle(packet(1, 101, struct.pack("<HH", 30, 60)))
        self.assertEqual(self.receiver.run_id, 101)
        self.assertEqual(self.receiver.phase, 1)
        self.assertEqual(self.receiver.received, 0)

    def test_busy_run_is_reported_to_new_request_without_erasing_measured_samples(self):
        self.start()
        self.sample(0)
        self.receiver.handle(packet(1, 101, struct.pack("<HH", 30, 60)))
        self.assertEqual(struct.unpack("<BBI", self.sent[-1]), (1, 6, 101))
        self.assertEqual(self.receiver.run_id, 100)
        self.assertEqual(self.receiver.received, 1)

    def test_cancel_is_scoped_to_run_and_releases_a_partially_measured_test(self):
        self.start()
        self.sample(0)
        self.receiver.handle(packet(5, 101))
        self.assertEqual(self.receiver.phase, 2)
        self.receiver.handle(packet(5))
        self.assertEqual(self.receiver.phase, 3)
        self.receiver.handle(packet(1, 101, struct.pack("<HH", 30, 60)))
        self.assertEqual(self.receiver.run_id, 101)
        self.assertEqual(self.receiver.received, 0)

    def test_continuous_real_node_input_yields_for_heartbeats_and_receiver_reports(self):
        writes = []
        transport = PollBudgetTransport(writer=writes.append)
        node = MultiAgentNode("budget-test", transport=transport)
        node.started = node.ready = True
        node.robot_id = 1
        node._last_hello_ms = node._last_heartbeat_ms = 100
        receiver = RateReceiver(lambda data: node.send(0, 0x7F30, data), lambda: self.now, lambda a, b: a - b)
        node.on_topic(0x7F30, lambda message: receiver.handle(message.payload))
        receiver.handle(packet(1, body=struct.pack("<HH", 30, 60)))
        sequence = [0]

        def continuous(_transport):
            value = sequence[0]
            sequence[0] += 1
            return encode_packet(MultiAgentMessage(KIND_DATA, 0, 1, value, 0x7F30,
                payload=packet(2, body=struct.pack("<Hhh", value, 0, 0))))

        self.now = 2000
        with patch.object(MultiAgentTransport, "read_available", continuous), patch("MultiAgentLib.node.ticks_ms", lambda: self.now):
            transport.begin_poll()
            self.assertEqual(node.poll(), 4)
            receiver.poll()
        self.assertEqual(receiver.received, 4)
        self.assertEqual(sequence[0], 4)
        self.assertTrue(any(decode_message(decode_xpp(data)[1]).kind == KIND_HEARTBEAT for data in writes))
        reports = [decode_message(decode_xpp(data)[1]).payload for data in writes
                   if decode_message(decode_xpp(data)[1]).kind == KIND_DATA]
        self.assertEqual(reports[-1][6], 2)

    def test_stream_read_budget_bounds_inner_byte_loop_and_preserves_fragmented_frames(self):
        frame = b"__XRPMA__:" + b"ab" * 32 + b"\n"

        class Reader(io.BytesIO):
            calls = 0
            def read(self, amount):
                self.calls += 1
                return super().read(amount)

        class Poller:
            def __init__(self, reader):
                self.reader = reader
            def poll(self, _timeout):
                return [(0, 1)] if self.reader.tell() < len(frame) else []

        transport = PollBudgetTransport()
        reader = Reader(frame)
        transport._usb_reader = reader
        transport._usb_poller = Poller(reader)
        transport.begin_poll()
        self.assertIsNone(transport.read_available())
        self.assertEqual(reader.calls, 32)
        transport.begin_poll()
        self.assertIsNone(transport.read_available())
        self.assertEqual(reader.calls, 64)
        transport.begin_poll()
        self.assertEqual(transport.read_available(), b"\xab" * 32)
        self.assertEqual(reader.calls, len(frame))
        self.assertEqual(MultiAgentTransport()._maximum_stream_read_attempts, 512)

    def test_invalid_stream_budget_is_rejected_without_changing_the_default(self):
        for value in (0, 513, "32", None):
            with self.assertRaises(ValueError):
                MultiAgentTransport(maximum_stream_read_attempts=value)

    def test_final_snapshot_is_repeated_a_bounded_number_of_times_with_frozen_counters(self):
        self.start(1)
        self.sample(0)
        self.now = 50
        self.sample(1)
        self.now = 1100
        self.receiver.handle(packet(3))
        frozen = self.sent[-1]
        baseline_count = len(self.sent)
        for now in (2100, 3100, 4100, 5100, 6100):
            self.now = now
            self.sample(2)
            self.receiver.poll()
        self.assertEqual(len(self.sent), baseline_count + 3)
        self.assertTrue(all(data == frozen for data in self.sent[-4:]))
        self.assertEqual(self.receiver.received, 2)
        self.assertEqual(self.receiver.within, 2)

    def test_lost_stop_does_not_block_auto_finalization_or_add_late_samples_to_the_window(self):
        self.start(1)
        self.sample(0)
        self.now = 1200
        self.sample(1)
        self.now = 16000
        self.receiver.poll()
        frozen = struct.unpack("<BBIBHHHHHHIIIHH", self.sent[-1])
        self.assertEqual(frozen[3], 3)
        self.assertEqual(frozen[4:6], (2, 1))
        self.assertEqual(frozen[-1], 1)
        self.now = 17000
        self.receiver.poll()
        self.assertEqual(struct.unpack("<BBIBHHHHHHIIIHH", self.sent[-1]), frozen)


if __name__ == "__main__":
    unittest.main()
