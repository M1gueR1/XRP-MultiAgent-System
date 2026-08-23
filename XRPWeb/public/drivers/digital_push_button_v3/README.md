# Digital Push Button V3 for XRPWeb

This package adds a MicroPython driver and four Blockly blocks for an
active-high external digital push button:

- `Digital Push Button V3 on GPIO ... is pressed?`
- `Digital Push Button V3 value on GPIO ...`
- `Wait for Digital Push Button V3 press`
- `Wait for Digital Push Button V3 release`

The GPIO dropdown contains the XRP RP2350 servo signal pins:

- GPIO 6 — Servo 1
- GPIO 7 — Servo 3
- GPIO 8 — Servo 4
- GPIO 9 — Servo 2

## Manual XRPWeb integration

1. Copy this complete folder to:
   `XRPWeb/public/drivers/digital_push_button_v3/`
2. Add the object from `drivers-entry.json` to the `drivers` array in:
   `XRPWeb/public/drivers/drivers.json`
3. Start or rebuild XRPWeb.
4. Connect the XRP and open the driver installer.
5. Select **Digital Push Button V3** and install it.
6. Reopen Blockly if necessary. The blocks will appear under:
   **3rd Party → Digital Push Button V3**

The package is self-contained. Its Blockly files are served from the same
driver folder; no files need to be added under `public/plugins/`.

## Wiring

- VCC → 3.3 V
- GND → GND
- Signal → one selected GPIO

Do not use the corresponding servo port for a servo at the same time.
