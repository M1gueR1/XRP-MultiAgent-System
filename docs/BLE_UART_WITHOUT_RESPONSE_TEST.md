# BLE UART without-response experiment

This is an optional, temporary RTT experiment for one XRP using BLE UART, not a
claim of 30 Hz command delivery. Keep the robot-side `blerepl.py` delay at 5 ms.
Do not change its output indication mode, firmware version, buffers, or main.py.

## Prepare the robot through its USB console

Stop the robot program, disconnect the IDE Bluetooth session, and select this
same XRP through the dashboard USB connection. Paste the following **directly
into the console**, not into a file followed by Run. It preserves a verified
backup before changing the UART RX flags. It keeps write-with-response support
and adds `_FLAG_WRITE_NO_RESPONSE = const(0x0004)`, as documented by MicroPython:
https://docs.micropython.org/en/v1.25.0/library/bluetooth.html

```python
exec("import os\np='/lib/ble/ble_uart_peripheral.py'\nb=p+'.before_uart_no_response.bak'\nwith open(p) as f: s=f.read()\na='_FLAG_WRITE = const(0x0008)'\nr='    _FLAG_WRITE,'\nassert s.count(a)==1 and s.count(r)==1 and '_FLAG_WRITE_NO_RESPONSE' not in s, 'Unexpected or already modified file; no changes made'\nn=s.replace(a,a+'\\n_FLAG_WRITE_NO_RESPONSE = const(0x0004)').replace(r,'    _FLAG_WRITE | _FLAG_WRITE_NO_RESPONSE,')\ncompile(n,p,'exec')\nif b.split('/')[-1] in os.listdir('/lib/ble'):\n with open(b) as f: saved=f.read()\n assert saved==s, 'Existing backup differs; no changes made'\nelse:\n with open(b,'w') as f: f.write(s)\nwith open(b) as f: assert f.read()==s, 'Backup verification failed'\nwith open(p,'w') as f: f.write(n)\nwith open(p) as f: assert f.read()==n, 'Write verification failed; restore backup'\nprint('SUCCESS: UART supports both write modes. Backup:',b)")
```

If an assertion or another error appears, stop and report it. Do not rerun the
patch after SUCCESS; it deliberately refuses to reapply or overwrite a backup.

Disconnect the dashboard USB session. Unplug/replug USB power, then reconnect
only through Bluetooth. GATT properties are announced at service registration,
so the edit alone does not update an already connected characteristic. The new
RTT checkbox stays disabled if the browser does not discover the advertised
write-without-response capability; do not bypass that check.

## A/B test

1. Run the same `rtt_single_robot.py` and wait for RTT_READY. Keep one XRP,
   distance and browser foreground unchanged.
2. Set Samples to 30 and keep **Pause automatic pings checked** for both series.
3. First leave **Use UART writes without response unchecked**. Collect 30 samples.
4. Check **Use UART writes without response**. Collect another 30 samples.
5. Export both series together. Keep failures as well as received responses.
   Compare mean, median, P95, response count and retries before testing load.
6. Optionally repeat the first condition to check session/time variation.

The experiment changes all multi-agent runtime writes for that XRP during the
series, not only PING probes. REPL, file upload and stop commands still use
explicit write-with-response when supported, with the older API as a fallback.
The normal UART mode is restored after completion, cancellation or failure.

The same 22-byte PING remains 55 bytes after ASCII framing. The no-response mode
uses three serialized browser writes (20 + 20 + 15 bytes), not a smaller message
and not a claim about radio packet count. Existing retry policy and reliable
application ACKs remain in place. A write promise resolving does not prove robot
receipt; the correlated PONG and timeout remain the RTT/delivery criterion.

CSV version 3 appends:

- `write_mode`: actual `with-response`, `without-response`, `legacy`, or `unknown`.
- `uart_without_response_requested`: whether the series selected the experiment.

This mode is opt-in and only available on a UART connection advertising support.
It is not a permanent setting and does not change dedicated BLE DATA or USB.

## Restore the robot file if needed

Use the USB console, with the program stopped and Bluetooth disconnected:

```python
exec("p='/lib/ble/ble_uart_peripheral.py'\nb=p+'.before_uart_no_response.bak'\nwith open(b) as f: s=f.read()\ncompile(s,p,'exec')\nassert '    _FLAG_WRITE,' in s and '_FLAG_WRITE_NO_RESPONSE' not in s, 'Unexpected backup; no changes made'\nwith open(p,'w') as f: f.write(s)\nwith open(p) as f: assert f.read()==s, 'Restore verification failed'\nprint('SUCCESS: original UART file restored')")
```

Disconnect USB in the dashboard and power-cycle before reconnecting Bluetooth.
Restoring this UART file does not undo the separate 5 ms `blerepl.py` change.

For a separate opt-in chunk-size comparison, see
[Small UART frames in one browser write](BLE_UART_55_BYTE_TEST.md). The original
unchecked chunk-size option remains the three-write baseline described above.
