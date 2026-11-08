"""Run via USB first. No native import, Bluetooth changes, or file writes."""
import sys
import json
import gc

try:
    import machine
    try:
        import ubinascii as binascii
    except ImportError:
        import binascii
    hardware_identity = binascii.hexlify(machine.unique_id()).decode()
except ImportError:
    hardware_identity = None

mpy = getattr(sys.implementation, '_mpy', None)
architectures = (None, 'x86', 'x64', 'armv6', 'armv6m', 'armv7m',
                 'armv7em', 'armv7emsp', 'armv7emdp', 'xtensa', 'xtensawin', 'rv32imc')
arch_id = None if mpy is None else mpy >> 10
architecture = None
if arch_id is not None and arch_id < len(architectures):
    architecture = architectures[arch_id]
uart_module = sys.modules.get('ble.blerepl')
uart = getattr(uart_module, 'uart', None) if uart_module is not None else None
report = {
    'report_version': 1,
    'hardware_identity': hardware_identity,
    'sys_version': sys.version,
    'implementation_name': sys.implementation.name,
    'machine_description': getattr(sys.implementation, '_machine', None),
    'mpy_raw': mpy,
    'mpy_version': None if mpy is None else mpy & 255,
    'mpy_sub_version': None if mpy is None else (mpy >> 8) & 3,
    'native_arch_id': arch_id,
    'native_architecture': architecture,
    'visible_ble_uart_object': uart is not None,
    'visible_binary_data_api': None if uart is None else (
        callable(getattr(uart, 'write_data', None)) and callable(getattr(uart, 'set_data_callback', None))
    ),
    'free_heap_bytes': gc.mem_free() if hasattr(gc, 'mem_free') else None,
    'native_module_imported': False,
}
print('NATIVE_CAPABILITIES_BEGIN')
print(json.dumps(report))
print('NATIVE_CAPABILITIES_END')
