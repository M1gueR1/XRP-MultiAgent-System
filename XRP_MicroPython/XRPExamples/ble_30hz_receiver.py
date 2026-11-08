"""Finite, no-motion receiver for the IDE's private 30 Hz load test.

Requires the optional stream-read budget in MultiAgentLib/transport.py.
It neither patches BLE nor imports motor APIs.
Arrival timing uses the robot's clock, not unsynchronised laptop timestamps.
"""
import math
import struct
import os
from MultiAgentLib.transport import MultiAgentTransport

# Opt-in only for this finite experiment. False reproduces the revision-5 path.
USE_BUFFERED_BLE_READER = True

TOPIC = 0x7F30
VERSION = 1
START, SAMPLE, STOP, REPORT, CANCEL, BUSY = 1, 2, 3, 4, 5, 6
MAX_SAMPLES = 1800
DIAGNOSTIC_KEYS = ("streamBytes", "readCalls", "readUs", "decodedFrames", "decodeUs",
                   "transportUs", "nodePollCalls", "nodePollUs", "nodePollMaxUs",
                   "loopGapMaxUs", "droppedChunks", "handlerUs", "writeUs")


class ReceiveDiagnostics:
    """Nested durations overlap. No printing or per-packet reports."""
    def __init__(self, clock, difference):
        self.clock, self.difference = clock, difference
        self.reset()

    def reset(self):
        self.values = dict((key, 0) for key in DIAGNOSTIC_KEYS)
        self.last_loop = None

    def elapsed(self, start):
        return max(0, self.difference(self.clock(), start))

    def snapshot(self):
        return struct.pack("<13I", *(min(0xFFFFFFFF, self.values[key]) for key in DIAGNOSTIC_KEYS))


class MeasuredReader:
    def __init__(self, reader, diagnostics):
        self.reader, self.diagnostics = reader, diagnostics

    def read(self, size):
        d = self.diagnostics
        start = d.clock()
        d.values["readCalls"] += 1
        try:
            value = self.reader.read(size)
            if value:
                d.values["streamBytes"] += len(value)
            return value
        finally:
            d.values["readUs"] += d.elapsed(start)


def existing_ble_uart(dupterm=None):
    """Inspect the existing terminal, restoring it before any validation/work.

    The XRP 1.25 BLEUART has a Python bytearray buffer and bounded slicing read.
    Do not import blerepl (which would create another BLE owner), replace its
    IRQ handler, or leave its dupterm detached. Unknown implementations fail.
    """
    duplicate = os.dupterm if dupterm is None else dupterm
    stream = None
    try:
        stream = duplicate(None, 0)
    finally:
        if stream is not None:
            duplicate(stream, 0)
    uart = getattr(stream, "_uart", None)
    if (type(stream).__name__ != "BLEUARTStream" or type(uart).__name__ != "BLEUART" or
            not isinstance(getattr(uart, "_rx_buffer", None), bytearray) or
            not callable(getattr(uart, "any", None)) or
            not callable(getattr(uart, "read", None))):
        raise RuntimeError("No compatible existing BLE UART buffer. Set USE_BUFFERED_BLE_READER = False for the stdin baseline.")
    return uart


class PollBudgetTransport(MultiAgentTransport):
    """Yield back to node/receiver housekeeping even under continuous RX."""
    def __init__(self, writer=None, diagnostics=None, buffered_ble=False):
        self.diagnostics = diagnostics
        self.buffered_ble = buffered_ble
        self._direct_uart = None
        self.reader_mode_id = 0
        try:
            super().__init__(writer=writer, maximum_stream_read_attempts=32)
        except TypeError:
            raise RuntimeError("Update /lib/MultiAgentLib/transport.py for RATE_TEST_REVISION 3")
        self._remaining = 0

    def attach_existing_stream(self, transport_name):
        if self.buffered_ble and transport_name != "Bluetooth UART":
            raise RuntimeError("Buffered BLE experiment requires the existing Bluetooth UART, not USB")
        super().attach_existing_stream(transport_name)
        if self.buffered_ble:
            self._direct_uart = existing_ble_uart()
            self.reader_mode_id = 1
        if self.diagnostics is not None:
            self._usb_reader = MeasuredReader(self._usb_reader, self.diagnostics)

    def attach_existing_ble(self):
        super().attach_existing_ble()
        if self._usb_reader is None:
            # Native DATA already bypasses stdin; do not relabel it as buffered UART.
            self.reader_mode_id = 2

    def _read_buffered_ble(self):
        if self._chunks:
            return self._chunks.pop(0)
        available = self._direct_uart.any()
        if available:
            # At most the same 32-byte budget as baseline; never ask for bytes
            # not already present. No sys.stdin poll/read or second RX consumer.
            d = self.diagnostics
            start = d.clock() if d is not None else 0
            if d is not None:
                d.values["readCalls"] += 1
            try:
                data = self._direct_uart.read(min(available, 32))
                if d is not None and data:
                    d.values["streamBytes"] += len(data)
            finally:
                if d is not None:
                    d.values["readUs"] += d.elapsed(start)
            if data:
                # ASCII framing cannot contain a raw Ctrl+C; preserve interruption.
                # The firmware still owns its stop marker and BLE IRQ/reset path.
                if b"\x03" in data:
                    raise KeyboardInterrupt
                try:
                    self._usb_text_buffer += data.decode("ascii")
                except UnicodeError:
                    raise RuntimeError("Non-ASCII data in buffered BLE experiment")
        self._decode_usb_frames()
        if self._chunks:
            return self._chunks.pop(0)
        return None

    def _on_data_irq(self, data):
        if self.diagnostics is not None:
            self.diagnostics.values["decodedFrames"] += 1
            if len(self._chunks) >= self._maximum_chunks:
                self.diagnostics.values["droppedChunks"] += 1
        super()._on_data_irq(data)

    def _decode_usb_frames(self):
        d = self.diagnostics
        if d is None:
            return super()._decode_usb_frames()
        start = d.clock()
        try:
            return super()._decode_usb_frames()
        finally:
            d.values["decodeUs"] += d.elapsed(start)

    def write(self, data):
        d = self.diagnostics
        if d is None:
            return super().write(data)
        start = d.clock()
        try:
            return super().write(data)
        finally:
            d.values["writeUs"] += d.elapsed(start)

    def begin_poll(self):
        self._remaining = 4

    def read_available(self):
        if self._remaining <= 0:
            return None
        self._remaining -= 1
        d = self.diagnostics
        if d is None:
            return self._read_buffered_ble() if self._direct_uart is not None else super().read_available()
        start = d.clock()
        try:
            return self._read_buffered_ble() if self._direct_uart is not None else super().read_available()
        finally:
            d.values["transportUs"] += d.elapsed(start)


class RateReceiver:
    def __init__(self, send, now, difference, diagnostics=None, reader_mode=None):
        self.reader_mode = reader_mode
        self.diagnostics = diagnostics
        self.send = send
        self.now = now
        self.difference = difference
        self.run_id = None
        self.phase = 0

    def handle(self, payload):
        data = bytes(payload)
        if len(data) < 6 or data[0] != VERSION:
            return
        op = data[1]
        run_id = struct.unpack("<I", data[2:6])[0]
        if op == START:
            if len(data) != 10:
                return
            hz, seconds = struct.unpack("<HH", data[6:])
            if hz not in (5, 10, 30) or not 1 <= seconds <= 60:
                return
            if run_id == self.run_id:
                self.report()
                return
            if self.phase == 2:
                try:
                    self.send(struct.pack("<BBI", VERSION, BUSY, run_id))
                except (OSError, RuntimeError):
                    pass
                return
            # A previous failed setup may be armed but has received no samples.
            # Replacing only that idle reservation cannot erase measured data.
            self.run_id = run_id
            self.run_reader_mode = None if self.reader_mode is None else self.reader_mode()
            if self.diagnostics is not None:
                self.diagnostics.reset()
            self.final_diagnostics = b""
            self.duration_ms = seconds * 1000
            self.total = hz * seconds
            self.seen = bytearray((self.total + 7) // 8)
            self.gaps = bytearray((self.total - 1) * 2)
            self.received = self.within = self.duplicates = self.out_of_order = self.invalid = 0
            self.last_sequence = 65535
            self.highest_sequence = -1
            self.first = self.last = None
            self.last_offset = self.max_gap = 0
            self.armed_at = self.last_report = self.now()
            self.report_pending = False
            self.final_repeats_remaining = 0
            self.final_elapsed_ms = None
            self.phase = 1
            self.report()
            return
        if run_id != self.run_id:
            return
        if op in (STOP, CANCEL) and len(data) == 6:
            self.finish()
            return
        if op != SAMPLE or self.phase not in (1, 2):
            return
        if len(data) != 12:
            self.invalid = min(65535, self.invalid + 1)
            return
        sequence, velocity, turn = struct.unpack("<Hhh", data[6:])
        if sequence >= self.total or velocity != 0 or turn != 0:
            self.invalid = min(65535, self.invalid + 1)
            return
        byte, bit = sequence // 8, 1 << (sequence % 8)
        if self.seen[byte] & bit:
            self.duplicates = min(65535, self.duplicates + 1)
            return
        self.seen[byte] |= bit
        now = self.now()
        if self.first is None:
            self.first = now
            self.phase = 2
        offset = max(0, self.difference(now, self.first))
        if self.last is not None:
            gap = max(0, self.difference(now, self.last))
            self.max_gap = max(self.max_gap, gap)
            struct.pack_into("<H", self.gaps, (self.received - 1) * 2, min(65534, gap))
        self.last = now
        self.last_offset = offset
        self.received += 1
        if offset < self.duration_ms:
            self.within += 1
        if sequence < self.highest_sequence:
            self.out_of_order += 1
        self.highest_sequence = max(self.highest_sequence, sequence)
        self.last_sequence = sequence

    def finish(self):
        if self.phase != 3:
            self.final_elapsed_ms = 0 if self.first is None else max(0, self.difference(self.now(), self.first))
            self.phase = 3
            self.final_repeats_remaining = 3
            self.final_diagnostics = b"" if self.diagnostics is None else self.diagnostics.snapshot()
        self.report()

    def report(self):
        if self.run_id is None:
            return
        elapsed = (self.final_elapsed_ms if self.phase == 3 else
                   0 if self.first is None else max(0, self.difference(self.now(), self.first)))
        p95 = 65535
        if self.phase == 3 and self.received > 1:
            gaps = sorted(struct.unpack_from("<H", self.gaps, index * 2)[0]
                          for index in range(self.received - 1))
            p95 = gaps[max(0, int(math.ceil(len(gaps) * 0.95)) - 1)]
        packet = struct.pack(
            "<BBIBHHHHHHIIIHH", VERSION, REPORT, self.run_id, self.phase,
            self.received, self.within, self.duplicates, self.out_of_order,
            self.invalid, self.last_sequence, elapsed, self.last_offset,
            self.max_gap, p95, self.received - self.within,
        )
        if self.phase == 3:
            packet += self.final_diagnostics
        if self.run_reader_mode is not None:
            packet += bytes((6, self.run_reader_mode))
        try:
            self.send(packet)
            self.report_pending = False
        except (OSError, RuntimeError):
            # A busy indication must not terminate reception or spin in the loop.
            self.report_pending = True
        self.last_report = self.now()

    def poll(self):
        if self.phase == 3:
            # A successful write is not proof that the final report arrived.
            # Repeat the frozen snapshot three times, then become silent.
            if self.final_repeats_remaining > 0 and self.difference(self.now(), self.last_report) >= 1000:
                self.final_repeats_remaining -= 1
                self.report()
            return
        if self.phase not in (1, 2):
            return
        now = self.now()
        # Cancellation/lost STOP never leaves an indefinitely active experiment.
        if self.difference(now, self.armed_at) >= self.duration_ms + 15000:
            self.finish()
        elif self.difference(now, self.last_report) >= 1000:
            self.report()


def main():
    import machine
    import time
    import ubinascii
    from MultiAgentLib.node import MultiAgentNode

    diagnostics = ReceiveDiagnostics(time.ticks_us, time.ticks_diff)
    transport = PollBudgetTransport(diagnostics=diagnostics, buffered_ble=USE_BUFFERED_BLE_READER)
    node = MultiAgentNode(ubinascii.hexlify(machine.unique_id()).decode(), transport=transport)
    receiver = RateReceiver(lambda payload: node.send(0, TOPIC, payload, ttl_ms=3000), time.ticks_ms, time.ticks_diff, diagnostics, lambda: transport.reader_mode_id)

    def on_message(message):
        if message.source_robot_id == 0 and message.target_robot_id == node.robot_id and message.flags == 0:
            start = diagnostics.clock()
            try:
                receiver.handle(message.payload)
            finally:
                diagnostics.values["handlerUs"] += diagnostics.elapsed(start)

    node.on_topic(TOPIC, on_message)
    node.start()
    started = time.ticks_ms()
    ready_at = None
    while True:
        start = diagnostics.clock()
        if diagnostics.last_loop is not None:
            diagnostics.values["loopGapMaxUs"] = max(diagnostics.values["loopGapMaxUs"], diagnostics.difference(start, diagnostics.last_loop))
        diagnostics.last_loop = start
        transport.begin_poll()
        node.poll()
        elapsed = diagnostics.elapsed(start)
        diagnostics.values["nodePollCalls"] += 1
        diagnostics.values["nodePollUs"] += elapsed
        diagnostics.values["nodePollMaxUs"] = max(diagnostics.values["nodePollMaxUs"], elapsed)
        while node.receive() is not None:
            pass
        receiver.poll()
        now = time.ticks_ms()
        if ready_at is None:
            if node.ready:
                ready_at = now
                print("RATE_TEST_READY:", node.robot_id)
                print("RATE_TEST_WINDOW: 5 minutes; no motor commands; Python backend")
                print("RATE_TEST_REVISION: 6; bounded buffered BLE experiment")
                print("RATE_TEST_READER:", ("stdin-bytewise", "ble-uart-buffered-32", "ble-data")[transport.reader_mode_id])
            elif time.ticks_diff(now, started) > 15000:
                raise RuntimeError("Team handshake timed out")
        elif time.ticks_diff(now, ready_at) >= 300000:
            print("RATE_TEST_WINDOW_FINISHED")
            break
        time.sleep_ms(5)


if __name__ == "__main__":
    main()
