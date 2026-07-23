import struct
import time

from MultiAgentLib import FLAG_ACK_REQUIRED, MultiAgentNode, TOPIC_EMOTION_STATE

# Optional application adapter. MultiAgentLib itself has no EmotionLib dependency.
node = MultiAgentNode("xrp-emotion-demo")
node.start()

last_emotion = None


def publish_emotion(target_robot_id, emotion_id, generation, flags=0):
    global last_emotion
    state = (emotion_id, generation, flags)
    if state == last_emotion:
        return False
    last_emotion = state
    node.send(
        target_robot_id,
        TOPIC_EMOTION_STATE,
        struct.pack("<BHB", emotion_id, generation, flags),
        FLAG_ACK_REQUIRED,
        2000,
    )
    return True


while True:
    node.poll()
    incoming = node.receive()
    if incoming is not None and incoming.topic_id == TOPIC_EMOTION_STATE:
        emotion_id, generation, flags = struct.unpack("<BHB", incoming.payload)
        print("emotion", emotion_id, "generation", generation, "from", incoming.source_robot_id)
    time.sleep_ms(10)

