import sys
import time
import machine
import ubinascii
from MultiAgentLib.team import get_default_team

print("VERSION:", sys.version)
print("XRP_ID:", ubinascii.hexlify(machine.unique_id()).decode())

team = get_default_team()
team.start()
announced = False

while True:
    team.update()
    if team.node.ready and not announced:
        print("RTT_READY:", team.robot_id)
        announced = True
    time.sleep_ms(5)
