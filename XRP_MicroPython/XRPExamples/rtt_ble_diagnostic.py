"""Opt-in BLE observation and RAM-only PING timing; safe to import at boot."""

import time

try:
    ticks_us = time.ticks_us
    ticks_diff = time.ticks_diff
except AttributeError:
    ticks_us = lambda: time.monotonic_ns() // 1000
    ticks_diff = lambda newer, older: newer - older


UART_PATH = "/lib/ble/ble_uart_peripheral.py"
BACKUP_SUFFIX = ".before_rtt_diagnostic.bak"
_IMPORT = "import rtt_ble_diagnostic as _xrp_rtt_diag\n\n"
_IRQ_ANCHOR = "    def _irq(self, event, data):\n"
_IRQ_HOOK = "        _xrp_rtt_diag.observe_irq(event, data)\n"

# All IRQ storage is allocated before Bluetooth starts. No prints or file I/O.
_link = [None, None, None, None, None, None]
_counts = [0, 0, 0, 0]
_connected = False


def observe_irq(event, data):
    global _connected
    _counts[0] += 1
    if event == 1:  # Central connected to this peripheral.
        _connected = True
        _link[0] = data[0]
        for index in range(1, 6):
            _link[index] = None
        _counts[1] += 1
    elif event == 2 and data[0] == _link[0]:
        _connected = False
        for index in range(6):
            _link[index] = None
    elif event == 27 and _connected and data[0] == _link[0]:
        _counts[2] += 1
        _link[4] = data[4]
        if data[4] == 0:
            _link[1] = data[1]
            _link[2] = data[2]
            _link[3] = data[3]
    elif event == 21 and _connected and data[0] == _link[0]:
        _link[5] = data[1]
        _counts[3] += 1


def link_snapshot():
    # Copy a coherent state without retaining the driver's event memoryview.
    try:
        import machine
        state = machine.disable_irq()
    except ImportError:
        machine = None
    try:
        link = _link[:]
        counts = _counts[:]
        connected = _connected
    finally:
        if machine is not None:
            machine.enable_irq(state)
    return {
        "observer_events": counts[0],
        "connections_observed": counts[1],
        "connection_updates_observed": counts[2],
        "mtu_events_observed": counts[3],
        "connected": connected,
        "connection_handle": link[0],
        "connection_interval_units_1_25_ms": link[1],
        "connection_interval_ms": None if link[1] is None else link[1] * 1.25,
        "peripheral_latency_events": link[2],
        "supervision_timeout_units_10_ms": link[3],
        "last_update_status": link[4],
        "negotiated_mtu": link[5],
    }


def _read_optional(path):
    import os
    try:
        os.stat(path)
    except OSError as error:
        if error.args[0] == 2:
            return None
        raise
    with open(path, "rb") as file:
        return file.read().decode("utf-8")


def _replace_verified(path, content):
    import os
    staged = path + ".rtt-diag.tmp"
    if _read_optional(staged) is not None:
        raise RuntimeError("Staging file already exists; inspect it before retrying: " + staged)
    with open(staged, "wb") as file:
        file.write(content.encode("utf-8"))
    if _read_optional(staged) != content:
        raise RuntimeError("Staging verification failed; original was not replaced")
    # If a firmware/filesystem cannot replace by rename, fail without deleting it.
    replace = getattr(os, "replace", os.rename)
    replace(staged, path)
    if _read_optional(path) != content:
        raise RuntimeError("File verification failed; recover using the verified backup")


def _patched_source(source):
    source = source.replace("\r\n", "\n")
    if (source.count("class BLEUART:") != 1 or source.count(_IRQ_ANCHOR) != 1
            or "_xrp_rtt_diag" in source):
        raise ValueError("Unexpected UART source; no changes made")
    patched = source.replace("class BLEUART:", _IMPORT + "class BLEUART:")
    patched = patched.replace(_IRQ_ANCHOR, _IRQ_ANCHOR + _IRQ_HOOK)
    compile(patched, UART_PATH, "exec")
    return patched


def install(path=UART_PATH):
    """Call over USB; IDE Run requires Boot Safety before/after its launcher."""
    source = _read_optional(path)
    if source is None:
        raise ValueError("UART source not found; no changes made")
    backup_path = path + BACKUP_SUFFIX
    backup = _read_optional(backup_path)
    if backup is not None and source == _patched_source(backup):
        print("ALREADY_INSTALLED: BLE observer matches its verified backup")
        return
    patched = _patched_source(source)
    if backup is not None and backup != source:
        raise ValueError("Existing backup differs; no changes made")
    compile(source, path, "exec")
    if backup is None:
        _replace_verified(backup_path, source)
    if _read_optional(backup_path) != source:
        raise RuntimeError("Backup verification failed; no UART changes made")
    _replace_verified(path, patched)
    print("SUCCESS: BLE observer installed. Backup:", backup_path)
    print("Disconnect USB in the IDE, power-cycle, then connect only by Bluetooth.")


def restore(path=UART_PATH):
    """Refuse to overwrite edits made after installation; retain the backup."""
    backup = _read_optional(path + BACKUP_SUFFIX)
    if backup is None:
        raise ValueError("Diagnostic backup not found; no changes made")
    source = _read_optional(path)
    if source == backup:
        print("ALREADY_RESTORED: original UART source is present")
        return
    if source != _patched_source(backup):
        raise ValueError("UART changed after installation; no changes made")
    compile(backup, path, "exec")
    _replace_verified(path, backup)
    print("SUCCESS: UART restored; prior 5 ms and RX flag settings are preserved")


class PingRecorder:
    """Wrap only this node instance. Record accepted PINGs, not duplicate drops."""

    COLUMNS = (
        "ping_sequence", "ping_payload_bytes", "read_call_us",
        "read_return_to_handler_us", "handler_us", "pong_submit_us", "poll_gap_us",
    )

    def __init__(self, node, maximum_samples=180, clock=ticks_us, diff=ticks_diff):
        if not isinstance(maximum_samples, int) or maximum_samples < 1:
            raise ValueError("maximum_samples must be a positive integer")
        self.node = node
        self.clock = clock
        self.diff = diff
        self.samples = [None] * maximum_samples
        self.total_samples = 0
        self._read_metrics = (None, None)
        self._previous_poll = None
        self._poll_gap = None
        self._current_ping = None
        self._attached = False

    def attach(self):
        if self._attached:
            raise RuntimeError("Recorder is already attached")
        if getattr(self.node, "_rtt_recorder", None) is not None:
            raise RuntimeError("Node already has a recorder")
        self._original_read = self.node.transport.read_available
        self._original_handle = self.node._handle_message
        self._original_send = self.node.send_control
        self._original_poll = self.node.poll
        self.node.transport.read_available = self._read
        self.node._handle_message = self._handle
        self.node.send_control = self._send
        self.node.poll = self._poll
        self.node._rtt_recorder = self
        self._attached = True

    def detach(self):
        if self._attached:
            self.node.transport.read_available = self._original_read
            self.node._handle_message = self._original_handle
            self.node.send_control = self._original_send
            self.node.poll = self._original_poll
            self.node._rtt_recorder = None
            self._attached = False

    def _read(self):
        started = self.clock()
        chunk = self._original_read()
        finished = self.clock()
        if chunk is not None:
            self._read_metrics = (finished, self.diff(finished, started))
        return chunk

    def _poll(self):
        started = self.clock()
        self._poll_gap = (None if self._previous_poll is None
                          else self.diff(started, self._previous_poll))
        self._previous_poll = started
        self._read_metrics = (None, None)
        return self._original_poll()

    def _send(self, kind, target_robot_id, payload=b"", topic_id=0, ttl_ms=0, flags=0):
        if kind != 0x21 or self._current_ping is None:
            return self._original_send(kind, target_robot_id, payload, topic_id, ttl_ms, flags)
        started = self.clock()
        result = self._original_send(kind, target_robot_id, payload, topic_id, ttl_ms, flags)
        self._current_ping[0] = self.diff(self.clock(), started)
        return result

    def _handle(self, message):
        if message.kind != 0x20:
            return self._original_handle(message)
        started = self.clock()
        read_return, read_duration = self._read_metrics
        dispatch = None if read_return is None else self.diff(started, read_return)
        current = [None]
        self._current_ping = current
        try:
            result = self._original_handle(message)
            finished = self.clock()
        finally:
            self._current_ping = None
        if current[0] is not None:
            row = (message.sequence, len(message.payload), read_duration, dispatch,
                   self.diff(finished, started), current[0], self._poll_gap)
            self.samples[self.total_samples % len(self.samples)] = row
            self.total_samples += 1
        return result

    def report(self):
        count = min(self.total_samples, len(self.samples))
        start = self.total_samples - count
        return {
            "sample_columns": self.COLUMNS,
            "samples": [self.samples[index % len(self.samples)]
                        for index in range(start, self.total_samples)],
            "total_accepted_pings": self.total_samples,
            "older_samples_discarded": self.total_samples - count,
            "includes_automatic_pings": True,
        }


def save_report(report, path="/ble_rtt_report.json"):
    import json
    _replace_verified(path, json.dumps(report))
