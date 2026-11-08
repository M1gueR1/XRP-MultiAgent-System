#ifndef XRP_CODEC_H
#define XRP_CODEC_H
#include <stddef.h>
#include <stdint.h>

#define XRP_HEADER_BYTES 14
#define XRP_MAX_PAYLOAD 220
#define XRP_MAX_PACKET 240

typedef struct {
    uint8_t version, kind, flags;
    uint16_t source, target, sequence, topic, ttl;
    uint8_t payload_size;
} xrp_header;

int xrp_valid_header(const xrp_header *header);
int xrp_decode(const uint8_t *data, size_t size, xrp_header *header);
size_t xrp_encode(const xrp_header *header, const uint8_t *payload, uint8_t *output);
int xrp_next_frame(const uint8_t *data, size_t size, size_t *cursor,
    size_t *start, size_t *length, size_t *discarded, size_t *invalid);
#endif
