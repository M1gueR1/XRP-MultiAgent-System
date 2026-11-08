@echo off
setlocal
title XRP Bluetooth RTT comparison - 3 minute window
echo Start the robot RTT program in the IDE BEFORE continuing.
echo Take the baseline 30-sample series BEFORE opening this utility.
echo This window holds the temporary profile for 180 seconds after confirmation.
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0XrpBleInterval.ps1" -Mode Probe -RttTest -HoldSeconds 180
echo.
echo The utility has ended. Keep the CSV and the JSON path shown above.
pause
endlocal
