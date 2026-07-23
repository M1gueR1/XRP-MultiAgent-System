import sys

try:
    import ubinascii as binascii
except ImportError:
    import binascii

try:
    import select
except ImportError:
    try:
        import uselect as select
    except ImportError:
        select = None

try:
    from ._transport_config import TRANSPORT as DEFAULT_TRANSPORT
except ImportError:
    DEFAULT_TRANSPORT = "bluetooth"


class MultiAgentTransport:
    """
    Adapter for either the XRP firmware's BLE DATA channel or USB serial.

    Importing this module never starts Bluetooth. The default adapter only
    attaches to the transport selected by the IDE. Explicit reader/writer
    injection remains available for tests and future firmware.
    """

    def __init__(self, writer=None, maximum_chunks=32):
        self._writer = writer
        self._usb_reader = None
        self._usb_poller = None
        self._usb_text_buffer = ""
        self._chunks = []
        self._maximum_chunks = maximum_chunks
        self.dropped_chunks = 0
        self._attached = False

    def attach_default(self):
        mode = str(DEFAULT_TRANSPORT).strip().lower()
        if mode == "usb":
            self.attach_existing_usb()
            return
        if mode == "bluetooth":
            self.attach_existing_ble()
            return
        raise RuntimeError("unsupported multi-agent transport: " + mode)

    def attach_existing_ble(self):
        module = sys.modules.get("ble.blerepl")
        uart = getattr(module, "uart", None) if module is not None else None
        if uart is None:
            raise RuntimeError("ble.blerepl is not active; Bluetooth was not started by MultiAgentLib")
        write_data = getattr(uart, "write_data", None)
        set_callback = getattr(uart, "set_data_callback", None)
        if not callable(write_data) or not callable(set_callback):
            raise RuntimeError("active XRP BLE firmware lacks the dedicated DATA API")
        self._writer = write_data
        set_callback(self._on_data_irq)
        self._attached = True

    def attach_existing_usb(self):
        if select is None:
            raise RuntimeError("USB team messaging requires select.poll")
        reader = getattr(sys.stdin, "buffer", sys.stdin)
        writer = sys.stdout
        poller = select.poll()
        poller.register(sys.stdin, getattr(select, "POLLIN", 1))
        self._usb_reader = reader
        self._usb_poller = poller

        def write_usb(data):
            encoded = binascii.hexlify(bytes(data)).decode("ascii")
            result = writer.write("__XRPMA__:" + encoded + "\n")
            flush = getattr(writer, "flush", None)
            if callable(flush):
                flush()
            return result

        self._writer = write_usb
        self._attached = True

    def _on_data_irq(self, data):
        # Keep IRQ work bounded. Decoding and user callbacks happen in poll().
        if len(self._chunks) >= self._maximum_chunks:
            self._chunks.pop(0)
            self.dropped_chunks += 1
        self._chunks.append(bytes(data))

    def inject_received(self, data):
        self._on_data_irq(data)

    def read_available(self):
        if self._chunks:
            return self._chunks.pop(0)
        if self._usb_reader is None or self._usb_poller is None:
            return None

        received = []
        attempts = 0
        while self._usb_poller.poll(0) and attempts < 512:
            attempts += 1
            try:
                value = self._usb_reader.read(1)
            except UnicodeError:
                # Discard any binary byte left by an older USB transport.
                continue
            if not value:
                break
            if not isinstance(value, str):
                try:
                    value = value.decode("ascii")
                except UnicodeError:
                    continue
            received.append(value)
        if received:
            self._usb_text_buffer += "".join(received)
        self._decode_usb_frames()
        if self._chunks:
            return self._chunks.pop(0)
        return None

    def _decode_usb_frames(self):
        prefix = "__XRPMA__:"
        while True:
            start = self._usb_text_buffer.find(prefix)
            if start < 0:
                # Only retain a possible fragmented prefix.
                self._usb_text_buffer = self._usb_text_buffer[-(len(prefix) - 1):]
                return
            if start > 0:
                self._usb_text_buffer = self._usb_text_buffer[start:]
            end = self._usb_text_buffer.find("\n", len(prefix))
            if end < 0:
                if len(self._usb_text_buffer) > 1024:
                    self._usb_text_buffer = self._usb_text_buffer[1:]
                    continue
                return
            encoded = self._usb_text_buffer[len(prefix):end].strip()
            self._usb_text_buffer = self._usb_text_buffer[end + 1:]
            try:
                packet = binascii.unhexlify(encoded)
            except (ValueError, TypeError):
                continue
            self._on_data_irq(packet)

    def write(self, data):
        if not callable(self._writer):
            raise RuntimeError("no multi-agent DATA writer is attached")
        return self._writer(bytes(data))

    def is_attached(self):
        return self._attached or callable(self._writer)
