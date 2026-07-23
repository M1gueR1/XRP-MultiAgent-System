from .constants import MAX_RECEIVE_BUFFER, XPP_END, XPP_START


class XPPStreamParser:
    def __init__(self, maximum_buffer_size=MAX_RECEIVE_BUFFER):
        if maximum_buffer_size < 261:
            raise ValueError("receive buffer must fit a maximum XPP packet")
        self.maximum_buffer_size = maximum_buffer_size
        self.buffer = bytearray()
        self.discarded_bytes = 0
        self.invalid_packets = 0
        self.overflows = 0

    def reset(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        packets = []
        if len(self.buffer) > self.maximum_buffer_size:
            remove = len(self.buffer) - self.maximum_buffer_size
            self.buffer = bytearray(self.buffer[remove:])
            self.discarded_bytes += remove
            self.overflows += 1

        while self.buffer:
            start = self.buffer.find(XPP_START)
            if start < 0:
                keep = 1 if self.buffer[-1] == XPP_START[0] else 0
                remove = len(self.buffer) - keep
                self.discarded_bytes += remove
                if keep:
                    self.buffer = bytearray(self.buffer[-1:])
                else:
                    self.buffer = bytearray()
                break
            if start:
                self.buffer = bytearray(self.buffer[start:])
                self.discarded_bytes += start
            if len(self.buffer) < 4:
                break
            total = self.buffer[3] + 6
            if len(self.buffer) < total:
                break
            if bytes(self.buffer[total - 2:total]) != XPP_END:
                self.buffer = bytearray(self.buffer[1:])
                self.invalid_packets += 1
                self.discarded_bytes += 1
                continue
            packets.append(bytes(self.buffer[:total]))
            self.buffer = bytearray(self.buffer[total:])
        return packets
