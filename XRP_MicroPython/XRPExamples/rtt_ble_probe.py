import sys
import time
import machine
import ubinascii
from MultiAgentLib.team import get_default_team
import rtt_ble_diagnostic as diagnostic

# Run clears non-BLE imports; reuse the observer retained by the live UART.
uart_module = sys.modules.get("ble.ble_uart_peripheral")
diagnostic = getattr(uart_module, "_xrp_rtt_diag", diagnostic)
sys.modules["rtt_ble_diagnostic"] = diagnostic

WINDOW_MS = 90000

print("VERSION:", sys.version)
print("XRP_ID:", ubinascii.hexlify(machine.unique_id()).decode())

if diagnostic.link_snapshot()["observer_events"] == 0:
    raise RuntimeError("BLE observer inactive. Install via USB and power-cycle first.")

team = get_default_team()
recorder = diagnostic.PingRecorder(team.node)
recorder.attach()
ready_at = None
link_at_ready = None
saved = False
started_at = time.ticks_ms()

try:
    team.start()
    while True:
        team.update()
        now = time.ticks_ms()
        if ready_at is None:
            if time.ticks_diff(now, started_at) >= 15000:
                raise RuntimeError("Team handshake timed out; no diagnostic report saved")
            if team.node.ready:
                ready_at = now
                link_at_ready = diagnostic.link_snapshot()
                print("RTT_READY:", team.node.robot_id)
                print("BLE_DIAGNOSTIC_LINK: MTU =", link_at_ready.get("negotiated_mtu"),
                      "; interval_ms =", link_at_ready.get("connection_interval_ms"))
                print("BLE_DIAGNOSTIC_WINDOW: 90 seconds. Start your 30-sample test now.")
        elif not saved and time.ticks_diff(now, ready_at) >= WINDOW_MS:
            recorder.detach()
            report = recorder.report()
            report["diagnostic_version"] = 1
            report["hardware_identity"] = team.node.hardware_identity
            report["robot_id"] = team.node.robot_id
            report["micropython_version"] = sys.version
            report["window_ms"] = time.ticks_diff(now, ready_at)
            report["ble_at_ready"] = link_at_ready
            report["ble_at_end"] = diagnostic.link_snapshot()
            diagnostic.save_report(report)
            saved = True
            print("BLE_DIAGNOSTIC_SAVED: /ble_rtt_report.json")
            # Return to REPL so Boot Safety can run without Bluetooth Stop/reset.
            break
        time.sleep_ms(5)
finally:
    recorder.detach()
