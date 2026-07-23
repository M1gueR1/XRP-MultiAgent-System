from MultiAgentLib.team import get_default_team
import time


team = get_default_team()
team.start()

if not team.wait_until_ready(5000):
    raise RuntimeError("The laptop team coordinator did not answer")

print("My XRP team ID is", team.robot_id)
counter = 0

while True:
    # Every XRP publishes its latest value. Robot broadcasts are relayed by
    # the laptop to every other connected team member, not back to the sender.
    team.broadcast("heartbeat", counter, mode="latest")

    if team.has_message("heartbeat"):
        print(
            "Received",
            team.read("heartbeat"),
            "from XRP ID",
            team.sender("heartbeat"),
        )

    counter += 1
    time.sleep(0.2)
