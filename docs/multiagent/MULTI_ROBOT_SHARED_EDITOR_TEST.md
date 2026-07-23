# Shared multi-XRP editor test

This phase lets one Python or Blockly editor tab target two or more XRP robots that are already connected in the USB or Bluetooth IDE fleet. The browser uploads and starts the same program on every assigned robot concurrently.

It uses the normal XRP firmware REPL. No user program needs to be running before the robots connect.

## Bluetooth test with two physical XRPs

1. In `XRPWeb`, run `npm run dev` and open the localhost URL printed by Vite in Chrome or Edge.
2. Power on both XRPs from their batteries. Do not run `multiagent_system_test.py`.
3. Open the dashboard and add the **Multi-Agent Lab** widget.
4. Under **Bluetooth IDE robot fleet**, press **Add XRP by Bluetooth** once for each physical robot.
5. Wait until both cards say `connected`. Renaming them, for example to `Red XRP` and `Blue XRP`, makes the save choices unambiguous.
6. At the top of the widget, press **Control all connected XRPs (2)**.
7. Choose **Python file** or **Blockly file**, enter its name, and use the new editor tab.
8. Confirm that the main Run button says **Run all** and is purple.

## Harmless Python test

Paste this into the shared Python tab:

```python
from XRPLib.board import Board
import time

board = Board.get_default_board()
board.led_on()
time.sleep(1)
board.led_off()
```

Press the purple **Run all** button. Both onboard LEDs should turn on at nearly the same time and turn off about one second later. Upload and execution commands are issued concurrently, although Bluetooth scheduling means they are not guaranteed to begin on the exact same millisecond.

## Save behavior

1. Change the shared program and press `Ctrl+S` (or the Save button).
2. Confirm the dialog offers:
   - **Save in all connected XRPs**
   - one button for each assigned robot
3. Save in all, then select each robot's individual IDE files and confirm the file exists on both.
4. Change a comment, save only to one named robot, and inspect both file trees to confirm only that robot received the latest version.

If an assigned robot has disconnected, the dialog identifies that some targets are unavailable. **Run all** requires every robot assigned to the tab to still be connected so a partial team run is not started accidentally.

## Stop behavior

Run a longer program from the shared tab and press the purple button again while it is running. Stop is sent to every connected robot assigned to that tab.

## Scope of this phase

This implements centralized multi-robot control from the laptop: shared source, concurrent deployment, Run all, and Stop all. It does not yet provide arbitrary live robot-to-robot application messages at 20–25 Hz. The separate **BLE message runtime** remains the experimental path for that later phase and currently requires `MultiAgentLib` on each robot.
