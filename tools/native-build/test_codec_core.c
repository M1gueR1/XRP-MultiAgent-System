#include <assert.h>
#include <stdio.h>
#include "xrp_codec.h"

int main(void) {
    uint8_t packet[XRP_MAX_PACKET], payload[XRP_MAX_PAYLOAD];
    for (size_t i = 0; i < sizeof(payload); ++i) { payload[i] = (uint8_t)i; }
    for (size_t n = 0; n <= XRP_MAX_PAYLOAD; ++n) {
        xrp_header h = {1, 0x10, 9, 0x1234, 65535, 0x0102, 0x0304, 0x0506, (uint8_t)n};
        size_t size = xrp_encode(&h, payload, packet);
        assert(size == 20 + n);
        xrp_header decoded;
        assert(xrp_decode(packet + 4, size - 6, &decoded));
        assert(decoded.sequence == h.sequence && decoded.payload_size == n);
        size_t cursor = 0, start = 0, length = 0, discarded = 0, invalid = 0;
        assert(xrp_next_frame(packet, size, &cursor, &start, &length, &discarded, &invalid));
        assert(cursor == size && length == size && start == 0 && discarded == 0 && invalid == 0);
        packet[4] = 2;
        assert(!xrp_decode(packet + 4, size - 6, &decoded));
    }
    /* Deterministic malformed-input stress under ASan and UBSan. */
    uint32_t seed = 7;
    uint8_t noise[1024];
    for (size_t trial = 0; trial < 50000; ++trial) {
        size_t size = trial % sizeof(noise);
        for (size_t i = 0; i < size; ++i) {
            seed = seed * 1664525u + 1013904223u;
            noise[i] = (uint8_t)(seed >> 24);
        }
        size_t cursor = 0, start = 0, length = 0, discarded = 0, invalid = 0;
        while (xrp_next_frame(noise, size, &cursor, &start, &length, &discarded, &invalid)) {
            assert(start + length <= size && length >= 6 && cursor <= size);
        }
        assert(cursor <= size && discarded <= size);
    }
    puts("C_CORE_OK: 221 payload lengths and 50000 malformed buffers; ASan/UBSan enabled");
    return 0;
}
