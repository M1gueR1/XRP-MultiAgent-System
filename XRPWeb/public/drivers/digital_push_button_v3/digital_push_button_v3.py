"""Digital Push Button V3 driver for the XRP Controller (RP2350)."""

from machine import Pin
from time import sleep_ms


class DigitalPushButtonV3:
    """Active-high digital push button connected to an RP2350 GPIO."""

    def __init__(self, pin=6, active_high=True, use_pull_down=True):
        pull = Pin.PULL_DOWN if use_pull_down else None
        self._pin = Pin(int(pin), Pin.IN, pull)
        self._active_high = bool(active_high)

    def value(self):
        """Return the raw digital level: 0 or 1."""
        return self._pin.value()

    def is_pressed(self):
        """Return True while the button is pressed."""
        level = self.value()
        return level == 1 if self._active_high else level == 0

    def wait_for_press(self, debounce_ms=25, poll_ms=5):
        """Block until a stable press is detected."""
        debounce_ms = max(0, int(debounce_ms))
        poll_ms = max(1, int(poll_ms))

        while not self.is_pressed():
            sleep_ms(poll_ms)

        if debounce_ms:
            sleep_ms(debounce_ms)
            while not self.is_pressed():
                sleep_ms(poll_ms)

        return True

    def wait_for_release(self, debounce_ms=25, poll_ms=5):
        """Block until a stable release is detected."""
        debounce_ms = max(0, int(debounce_ms))
        poll_ms = max(1, int(poll_ms))

        while self.is_pressed():
            sleep_ms(poll_ms)

        if debounce_ms:
            sleep_ms(debounce_ms)
            while self.is_pressed():
                sleep_ms(poll_ms)

        return True
