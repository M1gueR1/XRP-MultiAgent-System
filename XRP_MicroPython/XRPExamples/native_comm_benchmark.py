"""Offline CPU comparison, not a Bluetooth RTT or 30 Hz measurement."""
import sys
import time
import gc
import json
from MultiAgentLib.codec import encode_packet, decode_message
from MultiAgentLib.message import MultiAgentMessage
from MultiAgentLib.native_codec import NativeCodecBackend
from MultiAgentLib.stream_parser import XPPStreamParser


def median(values):
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def measure(operation, iterations=100, rounds=7):
    times = []
    for _round in range(rounds):
        gc.collect()
        started = time.ticks_us()
        for _index in range(iterations):
            operation()
        times.append(time.ticks_diff(time.ticks_us(), started) / iterations)
    return {'median_us_per_operation': median(times), 'round_means_us': times,
            'iterations_per_round': iterations}


native = NativeCodecBackend()  # Fail visibly rather than silently measuring Python twice.
results = []
for size in (2, 32, 220):
    message = MultiAgentMessage(0x10, 1, 2, 123, 0x8000, 2000, bytes(size))
    packet = encode_packet(message)
    assert native.encode_packet(message) == packet
    assert native.decode_message(packet[4:-2]).payload == message.payload
    parser_python = XPPStreamParser()
    parser_native = native.create_parser()
    assert parser_python.feed(packet) == parser_native.feed(packet)
    operations = (
        ('encode_packet', lambda: encode_packet(message), lambda: native.encode_packet(message)),
        ('decode_message', lambda: decode_message(packet[4:-2]), lambda: native.decode_message(packet[4:-2])),
        ('parse_complete_packet', lambda: parser_python.feed(packet), lambda: parser_native.feed(packet)),
    )
    for label, python_operation, native_operation in operations:
        # ABBA helps reveal drift instead of presenting a selected fastest run.
        measurements = []
        for backend, operation in (('python', python_operation), ('native', native_operation),
                                   ('native', native_operation), ('python', python_operation)):
            measurements.append({'backend': backend, 'timing': measure(operation)})
        results.append({'operation': label, 'payload_bytes': size, 'abba': measurements})

print('NATIVE_BENCHMARK_BEGIN')
print(json.dumps({'report_version': 1, 'measurement': 'offline_cpu_not_rtt',
                  'sys_version': sys.version, 'mpy_raw': getattr(sys.implementation, '_mpy', None),
                  'native_api_version': native.module.api_version(), 'results': results}))
print('NATIVE_BENCHMARK_END')
