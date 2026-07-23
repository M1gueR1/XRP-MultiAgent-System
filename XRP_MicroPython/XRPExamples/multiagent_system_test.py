import struct
import time

from MultiAgentLib import (
    FLAG_ACK_REQUIRED,
    MultiAgentNode,
    TOPIC_SYSTEM_TEST,
)

# Replace this with a stable hardware identity fragment when one is available.
node = MultiAgentNode("xrp-system-test")
node.start()

target_robot_id = 2
counter = 0
last_send = time.ticks_ms()

while True:
    node.poll()
    now = time.ticks_ms()
    if node.ready and time.ticks_diff(now, last_send) >= 1000:
        node.send(
            target_robot_id,
            TOPIC_SYSTEM_TEST,
            struct.pack("<I", counter),
            flags=FLAG_ACK_REQUIRED,
            ttl_ms=2000,
        )
        counter += 1
        last_send = now

    message = node.receive()
    if message is not None and message.topic_id == TOPIC_SYSTEM_TEST:
        value = struct.unpack("<I", message.payload)[0]
        print("SYSTEM_TEST from robot", message.source_robot_id, "counter", value)
    time.sleep_ms(10)

