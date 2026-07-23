# Multi-XRP USB/Serial test

This is the first phase of the multi-robot IDE connection. It uses each XRP's normal MicroPython REPL over Web Serial. Do not upload or run `multiagent_system_test.py` for this test.

## Requirements

- Chrome or Microsoft Edge.
- The dashboard opened from `localhost` (or HTTPS).
- Two XRP robots with normal XRP MicroPython firmware.
- One USB data cable and one computer USB port per robot.

The robots may be powered by USB or by their batteries. A USB data cable is still required during this serial phase.

## Test procedure

1. From `XRPWeb`, start the site with `npm run dev` and open the localhost URL printed by Vite.
2. Connect both XRPs to two different USB ports.
3. Open Dashboard, add the **Multi-Agent Lab** widget if it is not already visible.
4. Press **Add XRP by USB** and choose the first XRP serial port.
5. Wait until its card says `connected`.
6. Press **Add XRP by USB** again and choose the other XRP serial port.
7. Wait until both cards say `connected`.
8. Rename the cards to something physical and easy to verify, for example `Red XRP` and `Blue XRP`.
9. Press **Open this XRP in IDE** on `Red XRP`. The normal IDE folder tree, terminal, save, and run controls now target that robot.
10. Create or upload a harmless uniquely named file, such as `/red_test.py`.
11. Select `Blue XRP` from the widget. Confirm that `/red_test.py` is absent, then create `/blue_test.py`.
12. Switch between both cards and confirm that each file tree matches the selected physical robot.

## Safety behavior

- Both serial ports stay open, but only the selected card supplies IDE terminal and dashboard/XPP data.
- A tab opened from one USB XRP is bound to that robot for the current browser session. Save and Run are blocked if another XRP is selected.
- Selecting the same active XRP refreshes its file tree.
- Selecting a port that is already part of the fleet is rejected.

## Important distinction

This USB mode needs no user program running on either robot. MicroPython itself is still running as the XRP firmware; that firmware provides the REPL and filesystem service used by the IDE.

The existing **BLE message runtime** section is separate and still requires `MultiAgentLib`. Removing that requirement from Bluetooth file/IDE access is the next phase.
