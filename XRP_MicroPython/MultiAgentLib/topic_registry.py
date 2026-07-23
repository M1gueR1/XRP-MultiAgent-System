class TopicRegistry:
    def __init__(self, maximum_topics=32):
        self._codecs = {}
        self.maximum_topics = maximum_topics

    def register(self, topic_id, encoder, decoder):
        if topic_id in self._codecs:
            raise ValueError("topic is already registered")
        if len(self._codecs) >= self.maximum_topics:
            raise RuntimeError("topic registry is full")
        if not callable(encoder) or not callable(decoder):
            raise TypeError("topic encoder and decoder must be callable")
        self._codecs[topic_id] = (encoder, decoder)

    def encode(self, topic_id, value):
        return self._codecs[topic_id][0](value)

    def decode(self, topic_id, payload):
        return self._codecs[topic_id][1](payload)

    def contains(self, topic_id):
        return topic_id in self._codecs

