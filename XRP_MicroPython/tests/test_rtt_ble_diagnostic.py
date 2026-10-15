import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from XRPExamples import rtt_ble_diagnostic as diagnostic
from MultiAgentLib.codec import decode_message, decode_xpp, encode_packet
from MultiAgentLib.constants import KIND_PING, KIND_PONG, KIND_HEARTBEAT
from MultiAgentLib.message import MultiAgentMessage
from MultiAgentLib.node import MultiAgentNode, ticks_ms
from MultiAgentLib.transport import MultiAgentTransport


UART_SOURCE = '''from micropython import const
_FLAG_WRITE = const(0x0008)
_FLAG_WRITE_NO_RESPONSE = const(0x0004)
_UART_RX = ("rx", _FLAG_WRITE | _FLAG_WRITE_NO_RESPONSE)
class BLEUART:
    def __init__(self):
        self.original_events = []
    def _irq(self, event, data):
        self.original_events.append((event, tuple(data)))
'''


class BleObservationTests(unittest.TestCase):
    def setUp(self):
        diagnostic._link[:] = [None] * 6
        diagnostic._counts[:] = [0] * 4
        diagnostic._connected = False

    def test_parameters_are_unknown_until_observed_and_have_correct_units(self):
        initial = diagnostic.link_snapshot()
        self.assertIsNone(initial["connection_interval_ms"])
        self.assertIsNone(initial["negotiated_mtu"])
        diagnostic.observe_irq(1, (7, 0, b"address"))
        diagnostic.observe_irq(27, (7, 24, 2, 400, 0))
        diagnostic.observe_irq(21, (7, 185))
        result = diagnostic.link_snapshot()
        self.assertEqual(result["connection_interval_ms"], 30)
        self.assertEqual(result["peripheral_latency_events"], 2)
        self.assertEqual(result["supervision_timeout_units_10_ms"], 400)
        self.assertEqual(result["negotiated_mtu"], 185)

    def test_failed_and_foreign_updates_do_not_replace_successful_values(self):
        diagnostic.observe_irq(1, (7, 0, b"address"))
        diagnostic.observe_irq(27, (7, 24, 0, 400, 0))
        diagnostic.observe_irq(27, (7, 80, 4, 500, 1))
        diagnostic.observe_irq(27, (99, 120, 8, 600, 0))
        diagnostic.observe_irq(21, (99, 999))
        result = diagnostic.link_snapshot()
        self.assertEqual(result["connection_interval_ms"], 30)
        self.assertEqual(result["last_update_status"], 1)
        self.assertEqual(result["connection_updates_observed"], 2)
        self.assertIsNone(result["negotiated_mtu"])

    def test_reconnect_does_not_report_stale_parameters(self):
        diagnostic.observe_irq(1, (7, 0, b"address"))
        diagnostic.observe_irq(27, (7, 24, 0, 400, 0))
        diagnostic.observe_irq(21, (7, 185))
        diagnostic.observe_irq(2, (7, 0, b"address"))
        self.assertFalse(diagnostic.link_snapshot()["connected"])
        diagnostic.observe_irq(1, (8, 0, b"address"))
        result = diagnostic.link_snapshot()
        self.assertIsNone(result["connection_interval_ms"])
        self.assertIsNone(result["negotiated_mtu"])
        self.assertEqual(result["connections_observed"], 2)

    def test_patched_irq_preserves_original_handler_for_all_events(self):
        namespace = {}
        micropython = type("Micropython", (), {"const": staticmethod(lambda value: value)})
        with patch.dict(sys.modules, {"rtt_ble_diagnostic": diagnostic, "micropython": micropython}):
            exec(diagnostic._patched_source(UART_SOURCE), namespace)
        uart = namespace["BLEUART"]()
        events = [(1, (7, 0, b"address")), (27, (7, 24, 0, 400, 0)),
                  (3, (7, 10)), (20, (7, 11, 0)), (2, (7, 0, b"address"))]
        for event, data in events:
            uart._irq(event, data)
        self.assertEqual(uart.original_events, events)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "ble_uart_peripheral.py")
        self.write(self.path, UART_SOURCE)

    def write(self, path, source):
        with open(path, "w", newline="") as file:
            file.write(source)

    def read(self, path):
        with open(path, newline="") as file:
            return file.read()

    def quietly(self, function):
        with contextlib.redirect_stdout(io.StringIO()):
            function(self.path)

    def test_backup_install_repeat_and_exact_restore_preserve_rx_flags(self):
        self.quietly(diagnostic.install)
        self.assertEqual(self.read(self.path + diagnostic.BACKUP_SUFFIX), UART_SOURCE)
        installed = self.read(self.path)
        self.assertIn("_FLAG_WRITE | _FLAG_WRITE_NO_RESPONSE", installed)
        self.quietly(diagnostic.install)
        self.assertEqual(self.read(self.path), installed)
        self.quietly(diagnostic.restore)
        self.assertEqual(self.read(self.path), UART_SOURCE)
        self.quietly(diagnostic.restore)

    def test_unexpected_source_and_bad_backup_do_not_modify_uart(self):
        self.write(self.path, "class AnotherUART: pass\n")
        with self.assertRaises(ValueError):
            diagnostic.install(self.path)
        self.assertFalse(os.path.exists(self.path + diagnostic.BACKUP_SUFFIX))
        self.write(self.path, UART_SOURCE)
        self.write(self.path + diagnostic.BACKUP_SUFFIX, UART_SOURCE + "# other version\n")
        with self.assertRaises(ValueError):
            diagnostic.install(self.path)
        self.assertEqual(self.read(self.path), UART_SOURCE)

    def test_compile_failure_does_not_create_backup(self):
        source = UART_SOURCE + "invalid syntax !\n"
        self.write(self.path, source)
        with self.assertRaises(SyntaxError):
            diagnostic.install(self.path)
        self.assertEqual(self.read(self.path), source)
        self.assertFalse(os.path.exists(self.path + diagnostic.BACKUP_SUFFIX))

    def test_restore_refuses_to_overwrite_later_changes(self):
        self.quietly(diagnostic.install)
        changed = self.read(self.path) + "# later user change\n"
        self.write(self.path, changed)
        with self.assertRaises(ValueError):
            diagnostic.restore(self.path)
        self.assertEqual(self.read(self.path), changed)

    def test_existing_staging_file_does_not_get_overwritten(self):
        staged = self.path + diagnostic.BACKUP_SUFFIX + ".rtt-diag.tmp"
        self.write(staged, "unfinished previous operation")
        with self.assertRaises(RuntimeError):
            diagnostic.install(self.path)
        self.assertEqual(self.read(self.path), UART_SOURCE)
        self.assertEqual(self.read(staged), "unfinished previous operation")

    def test_crlf_source_is_backed_up_and_restored_byte_for_byte(self):
        source = UART_SOURCE.replace("\n", "\r\n")
        self.write(self.path, source)
        self.quietly(diagnostic.install)
        self.assertEqual(self.read(self.path + diagnostic.BACKUP_SUFFIX), source)
        self.quietly(diagnostic.restore)
        self.assertEqual(self.read(self.path), source)

    def test_rename_failure_keeps_original_and_verified_backup(self):
        real_rename = os.replace

        def rename(source, target):
            if target == self.path:
                raise OSError("rename replacement unsupported")
            return real_rename(source, target)

        with patch.object(os, "replace", rename), self.assertRaises(OSError):
            diagnostic.install(self.path)
        self.assertEqual(self.read(self.path), UART_SOURCE)
        self.assertEqual(self.read(self.path + diagnostic.BACKUP_SUFFIX), UART_SOURCE)

    def test_json_report_survives_restart_and_can_be_replaced(self):
        path = os.path.join(self.directory.name, "ble_rtt_report.json")
        diagnostic.save_report({"samples": [[1, 2, None]], "version": 1}, path)
        self.assertEqual(json.loads(self.read(path))["samples"], [[1, 2, None]])
        diagnostic.save_report({"samples": [[2]], "version": 1}, path)
        self.assertEqual(json.loads(self.read(path))["samples"], [[2]])


class PingRecorderTests(unittest.TestCase):
    def setUp(self):
        self.writes = []
        self.transport = MultiAgentTransport(writer=lambda packet: self.writes.append(packet))
        self.node = MultiAgentNode("timing-test", self.transport)
        self.node.started = True
        self.node.ready = True
        self.node.robot_id = 1
        self.node._last_hello_ms = ticks_ms()
        self.node._last_heartbeat_ms = ticks_ms()

    def ping(self, sequence, target=1):
        return MultiAgentMessage(KIND_PING, 0, target, sequence, payload=bytes((sequence, 0)))

    def test_wrapped_poll_keeps_exact_pong_bytes_and_control_messages(self):
        baseline_writes = []
        baseline = MultiAgentNode("timing-test", MultiAgentTransport(writer=baseline_writes.append))
        baseline.ready = True
        baseline.robot_id = 1
        baseline._handle_message(self.ping(42))
        recorder = diagnostic.PingRecorder(self.node)
        recorder.attach()
        self.addCleanup(recorder.detach)
        self.transport.inject_received(encode_packet(self.ping(42)))
        self.assertEqual(self.node.poll(), 1)
        self.assertEqual(self.writes, baseline_writes)
        self.node.send_control(KIND_HEARTBEAT, 0)
        kind, payload = decode_xpp(self.writes[-1])
        self.assertEqual(decode_message(payload).kind, KIND_HEARTBEAT)
        result = recorder.report()
        self.assertEqual(result["total_accepted_pings"], 1)
        self.assertEqual(result["samples"][0][0], 42)
        self.assertEqual(result["samples"][0][1], 2)
        self.assertIsNotNone(result["samples"][0][2])

    def test_duplicates_wrong_targets_and_not_ready_do_not_add_timing_rows(self):
        recorder = diagnostic.PingRecorder(self.node)
        recorder.attach()
        self.addCleanup(recorder.detach)
        self.node._handle_message(self.ping(1))
        self.node._handle_message(self.ping(1))
        self.node._handle_message(self.ping(2, target=2))
        self.node.ready = False
        self.node._handle_message(self.ping(3))
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(recorder.total_samples, 1)
        self.assertIsNone(recorder.report()["samples"][0][2])

    def test_ring_retains_newest_samples_and_reports_drops(self):
        recorder = diagnostic.PingRecorder(self.node, maximum_samples=2)
        recorder.attach()
        self.addCleanup(recorder.detach)
        for sequence in range(5):
            self.node._handle_message(self.ping(sequence))
        result = recorder.report()
        self.assertEqual([row[0] for row in result["samples"]], [3, 4])
        self.assertEqual(result["older_samples_discarded"], 3)
        self.assertEqual(result["total_accepted_pings"], 5)

    def test_failure_clears_context_and_detach_restores_every_method(self):
        def fail_write(_data):
            raise OSError("radio unavailable")

        self.transport._writer = fail_write
        originals = (self.node._handle_message, self.node.send_control,
                     self.node.poll, self.transport.read_available)
        recorder = diagnostic.PingRecorder(self.node)
        recorder.attach()
        with self.assertRaises(OSError):
            self.node._handle_message(self.ping(1))
        self.assertIsNone(recorder._current_ping)
        self.assertEqual(recorder.total_samples, 0)
        recorder.detach()
        recorder.detach()
        self.assertEqual(originals, (self.node._handle_message, self.node.send_control,
                                   self.node.poll, self.transport.read_available))

    def test_timing_uses_wrap_safe_difference_and_handler_includes_submit(self):
        moment = [95]

        def clock():
            return moment[0] % 100

        def handle(message):
            moment[0] += 2
            self.node.send_control(KIND_PONG, 0, message.payload)
            moment[0] += 3

        def send(*_args):
            moment[0] += 7
            return 42

        self.node._handle_message = handle
        self.node.send_control = send
        recorder = diagnostic.PingRecorder(self.node, clock=clock,
                                           diff=lambda newer, older: (newer - older + 50) % 100 - 50)
        recorder.attach()
        self.addCleanup(recorder.detach)
        self.assertIsNone(self.node._handle_message(self.ping(1)))
        row = recorder.report()["samples"][0]
        self.assertEqual(row[4], 12)
        self.assertEqual(row[5], 7)

    def test_repeated_attach_and_second_recorder_are_rejected(self):
        recorder = diagnostic.PingRecorder(self.node)
        recorder.attach()
        self.addCleanup(recorder.detach)
        with self.assertRaises(RuntimeError):
            recorder.attach()
        with self.assertRaises(RuntimeError):
            diagnostic.PingRecorder(self.node).attach()


class ProbeProgramTests(unittest.TestCase):
    setUp = PingRecorderTests.setUp
    ping = PingRecorderTests.ping

    def test_full_window_has_no_per_ping_output_or_flash_writes(self):
        now = [0]
        reports = []
        sleeps = []
        output = io.StringIO()
        steps = [0]
        original_poll = self.node.poll

        def update():
            if steps[0] < 30:
                self.transport.inject_received(encode_packet(self.ping(steps[0])))
            steps[0] += 1
            return self.node.poll()

        def sleep(milliseconds):
            sleeps.append(milliseconds)
            now[0] += 1000
            if reports:
                raise KeyboardInterrupt()

        def save(report):
            self.assertEqual(now[0], 90000)
            reports.append(report)

        fake_team = SimpleNamespace(node=self.node, start=lambda: None, update=update)
        fake_time = SimpleNamespace(ticks_ms=lambda: now[0], ticks_diff=lambda a, b: a - b,
                                    sleep_ms=sleep)
        fake_machine = SimpleNamespace(unique_id=lambda: b"\x01\x02")
        fake_binascii = SimpleNamespace(hexlify=lambda value: value.hex().encode("ascii"))
        probe = os.path.join(os.path.dirname(diagnostic.__file__), "rtt_ble_probe.py")
        modules = {"time": fake_time, "machine": fake_machine,
                   "ubinascii": fake_binascii, "rtt_ble_diagnostic": diagnostic}
        # The IDE preserves the UART module but removes its observer's cache key.
        # A fresh import must not cause an empty observer to replace the live one.
        modules["ble.ble_uart_peripheral"] = SimpleNamespace(_xrp_rtt_diag=diagnostic)
        modules["rtt_ble_diagnostic"] = SimpleNamespace(
            link_snapshot=lambda: {"observer_events": 0})
        with patch.dict(sys.modules, modules), \
                patch("MultiAgentLib.team.get_default_team", return_value=fake_team), \
                patch.object(diagnostic, "link_snapshot", return_value={"observer_events": 1}), \
                patch.object(diagnostic, "save_report", side_effect=save), \
                contextlib.redirect_stdout(output):
            runpy.run_path(probe, run_name="__main__")
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["total_accepted_pings"], 30)
        self.assertEqual(reports[0]["window_ms"], 90000)
        self.assertEqual(self.node.poll, original_poll)
        self.assertTrue(all(value == 5 for value in sleeps))
        self.assertEqual(len(output.getvalue().splitlines()), 6)
        self.assertIn("BLE_DIAGNOSTIC_LINK", output.getvalue())
        self.assertIn("BLE_DIAGNOSTIC_SAVED", output.getvalue())

    def test_probe_refuses_inactive_observer_before_starting_team(self):
        probe = os.path.join(os.path.dirname(diagnostic.__file__), "rtt_ble_probe.py")
        modules = {"machine": SimpleNamespace(unique_id=lambda: b"id"),
                   "ubinascii": SimpleNamespace(hexlify=lambda value: value.hex().encode("ascii")),
                   "rtt_ble_diagnostic": diagnostic}
        with patch.dict(sys.modules, modules), \
                patch("MultiAgentLib.team.get_default_team") as get_team, \
                patch.object(diagnostic, "link_snapshot", return_value={"observer_events": 0}), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "inactive"):
            runpy.run_path(probe, run_name="__main__")
        get_team.assert_not_called()


if __name__ == "__main__":
    unittest.main()
