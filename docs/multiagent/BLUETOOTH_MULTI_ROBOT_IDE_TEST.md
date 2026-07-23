# Multi-XRP Bluetooth IDE test

This phase connects multiple battery-powered XRPs to one browser tab through the normal XRP firmware Bluetooth UART/REPL service. It provides the regular IDE filesystem, terminal, Save, and Run operations without USB cables and without a user program such as `multiagent_system_test.py`.

## Requirements

- Chrome or Microsoft Edge on a computer with Bluetooth enabled.
- The dashboard opened from `localhost` or HTTPS.
- Two XRPs running the standard XRP MicroPython firmware.
- Both robots powered on from their batteries.
- No other browser tab, IDE, or computer connected to either XRP over Bluetooth.

## Physical test

1. From `XRPWeb`, run `npm run dev` and open the localhost URL printed by Vite.
2. Disconnect the USB data cables from both robots so the test is Bluetooth-only.
3. Power on both XRPs and wait a few seconds for their Bluetooth advertisements.
4. Open Dashboard and the **Multi-Agent Lab** widget.
5. Under **Bluetooth IDE robot fleet**, press **Add XRP by Bluetooth**.
6. Select the first XRP in the browser chooser and wait for its card to say `connected`.
7. Press **Add XRP by Bluetooth** again and select the other XRP.
8. Wait for both cards to say `connected`. Each chooser selection must be a different physical robot.
9. Rename the cards to match the robots, such as `Red XRP` and `Blue XRP`.
10. Press **Open this XRP in IDE** on `Red XRP`; create or upload `/red_ble_test.py`.
11. Select `Blue XRP`; confirm the red file is absent and create `/blue_ble_test.py`.
12. Switch between the cards and confirm that the folder tree changes to the selected robot.
13. Open a file from each robot. With the other robot selected, verify that Save and Run refuse to target the wrong XRP.
14. Run a short harmless program on each robot after selecting its card.

Initial connection can take several seconds because the IDE enters the firmware REPL, reads the complete filesystem, and performs the normal compatibility checks.

## Expected behavior

- Both GATT connections remain open concurrently.
- Only the selected robot sends terminal and dashboard/XPP data into the legacy IDE UI.
- Filesystem, terminal input, Save, Run, Stop, and plugin checks target the selected card.
- A physical Bluetooth drop attempts to reconnect that robot without disturbing a different active robot.
- Explicit **Disconnect** does not trigger the old automatic reconnect loop.
- Selecting the same Bluetooth device twice is rejected.

## Firmware distinction

**Bluetooth IDE robot fleet** uses the UART/REPL service already started by standard XRP firmware. It does not use `MultiAgentLib` and does not need a user script.

**BLE message runtime** remains a separate experimental mode for high-rate application messages and still requires a robot application that starts `MultiAgentNode`.
