"""Run only after native compatibility is verified; finite, same-path A/B test."""
import sys
import time
import machine
import ubinascii
from MultiAgentLib.node import MultiAgentNode
from MultiAgentLib.team import TeamLink
from MultiAgentLib.native_codec import NativeCodecBackend

USE_NATIVE = False
WINDOW_MS = 90000

backend = NativeCodecBackend() if USE_NATIVE else None
identity = ubinascii.hexlify(machine.unique_id()).decode()
node = MultiAgentNode(identity, codec_backend=backend)
team = TeamLink(node=node)
print('VERSION:', sys.version)
print('XRP_ID:', identity)
print('RTT_BACKEND:', 'native_c' if USE_NATIVE else 'python')
print('RTT_SCOPE: same BLE transport; this test does not bypass the REPL')
team.start()
started = time.ticks_ms()
ready = None
while True:
    team.update()
    now = time.ticks_ms()
    if ready is None:
        if time.ticks_diff(now, started) > 15000:
            raise RuntimeError('Team handshake timed out')
        if node.ready:
            ready = now
            print('RTT_READY:', node.robot_id)
            print('RTT_WINDOW: 90 seconds; collect one 30-sample series only.')
    elif time.ticks_diff(now, ready) >= WINDOW_MS:
        print('RTT_WINDOW_FINISHED: returning to REPL without reset')
        break
    time.sleep_ms(5)
