class MultiAgentDiagnostics:
    def __init__(self):
        self.messages_sent = 0
        self.messages_received = 0
        self.bytes_sent = 0
        self.bytes_received = 0
        self.invalid_packets = 0
        self.dropped_messages = 0
        self.duplicate_messages = 0
        self.stale_messages = 0
        self.maximum_receive_depth = 0

    def snapshot(self):
        return {
            "messages_sent": self.messages_sent,
            "messages_received": self.messages_received,
            "bytes_sent": self.bytes_sent,
            "bytes_received": self.bytes_received,
            "invalid_packets": self.invalid_packets,
            "dropped_messages": self.dropped_messages,
            "duplicate_messages": self.duplicate_messages,
            "stale_messages": self.stale_messages,
            "maximum_receive_depth": self.maximum_receive_depth,
        }

