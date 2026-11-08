@echo off
setlocal
title XRP Bluetooth interval probe
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0XrpBleInterval.ps1" -Mode Probe
echo.
echo The utility has ended. See the RESULT or ERROR above.
pause
endlocal
