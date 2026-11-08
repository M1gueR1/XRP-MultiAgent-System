#include "py/dynruntime.h"
#include "xrp_codec.h"

static mp_uint_t unsigned_arg(mp_obj_t object, mp_uint_t maximum) {
    if (!mp_obj_is_int(object)) { mp_raise_TypeError("header field must be an integer, not boolean"); }
    if (!mp_obj_is_small_int(object) && (
        mp_obj_is_true(mp_binary_op(MP_BINARY_OP_LESS, object, mp_obj_new_int(0))) ||
        mp_obj_is_true(mp_binary_op(MP_BINARY_OP_MORE, object, mp_obj_new_int_from_uint(maximum))))) {
        mp_raise_ValueError("header field outside unsigned range");
    }
    mp_int_t value = mp_obj_get_int(object);
    if (value < 0 || (mp_uint_t)value > maximum) { mp_raise_ValueError("header field outside unsigned range"); }
    return (mp_uint_t)value;
}

static mp_obj_t api_version(void) { return mp_obj_new_int(1); }
static MP_DEFINE_CONST_FUN_OBJ_0(api_version_obj, api_version);

static mp_obj_t encode_packet(size_t n_args, const mp_obj_t *args) {
    (void)n_args;
    xrp_header h;
    /* Version/kind historically accept bool as byte-valued integers. */
    mp_int_t version = mp_obj_get_int(args[0]);
    mp_int_t kind = mp_obj_get_int(args[1]);
    if (version != 1 || kind < 0 || kind > 255) { mp_raise_ValueError("unsupported protocol version or kind"); }
    h.version = (uint8_t)version; h.kind = (uint8_t)kind;
    h.flags = unsigned_arg(args[2], 255);
    h.source = unsigned_arg(args[3], 65534);
    h.target = unsigned_arg(args[4], 65535);
    h.sequence = unsigned_arg(args[5], 65535);
    h.topic = unsigned_arg(args[6], 65535);
    h.ttl = unsigned_arg(args[7], 65535);
    mp_buffer_info_t payload;
    mp_get_buffer_raise(args[8], &payload, MP_BUFFER_READ);
    if (payload.len > XRP_MAX_PAYLOAD) { mp_raise_ValueError("application payload exceeds 220 bytes"); }
    h.payload_size = payload.len;
    if (!xrp_valid_header(&h)) { mp_raise_ValueError("unknown multi-agent message kind"); }
    uint8_t output[XRP_MAX_PACKET];
    size_t length = xrp_encode(&h, payload.buf, output);
    return mp_obj_new_bytes(output, length);
}
static MP_DEFINE_CONST_FUN_OBJ_VAR_BETWEEN(encode_packet_obj, 9, 9, encode_packet);

static mp_obj_t decode_message(mp_obj_t data) {
    mp_buffer_info_t buffer;
    mp_get_buffer_raise(data, &buffer, MP_BUFFER_READ);
    xrp_header h;
    if (!xrp_decode(buffer.buf, buffer.len, &h)) { mp_raise_ValueError("invalid multi-agent envelope"); }
    mp_obj_t fields[9] = {
        mp_obj_new_int(h.version), mp_obj_new_int(h.kind), mp_obj_new_int(h.flags),
        mp_obj_new_int(h.source), mp_obj_new_int(h.target), mp_obj_new_int(h.sequence),
        mp_obj_new_int(h.topic), mp_obj_new_int(h.ttl),
        mp_obj_new_bytes((uint8_t *)buffer.buf + XRP_HEADER_BYTES, h.payload_size),
    };
    return mp_obj_new_tuple(9, fields);
}
static MP_DEFINE_CONST_FUN_OBJ_1(decode_message_obj, decode_message);

static mp_obj_t parse_xpp(mp_obj_t data, mp_obj_t maximum) {
    mp_buffer_info_t buffer;
    mp_get_buffer_raise(data, &buffer, MP_BUFFER_READ);
    mp_uint_t limit = unsigned_arg(maximum, 0x3fffffff);
    if (limit < 261) { mp_raise_ValueError("receive buffer must fit a maximum XPP packet"); }
    size_t trim = buffer.len > limit ? buffer.len - limit : 0;
    const uint8_t *bytes = (const uint8_t *)buffer.buf;
    /* Avoid pointer arithmetic on a possibly null empty-buffer pointer. */
    if (trim) { bytes += trim; }
    size_t size = buffer.len - trim;
    size_t cursor = 0, start = 0, length = 0, discarded = trim, invalid = 0;
    mp_obj_t frames = mp_obj_new_list(0, NULL);
    while (xrp_next_frame(bytes, size, &cursor, &start, &length, &discarded, &invalid)) {
        mp_obj_list_append(frames, mp_obj_new_bytes(bytes + start, length));
    }
    mp_obj_t result[5] = {
        frames, mp_obj_new_bytes(size ? bytes + cursor : NULL, size - cursor),
        mp_obj_new_int_from_uint(discarded), mp_obj_new_int_from_uint(invalid),
        mp_obj_new_int(trim ? 1 : 0),
    };
    return mp_obj_new_tuple(5, result);
}
static MP_DEFINE_CONST_FUN_OBJ_2(parse_xpp_obj, parse_xpp);

mp_obj_t mpy_init(mp_obj_fun_bc_t *self, size_t n_args, size_t n_kw, mp_obj_t *args) {
    MP_DYNRUNTIME_INIT_ENTRY
    mp_store_global(MP_QSTR_api_version, MP_OBJ_FROM_PTR(&api_version_obj));
    mp_store_global(MP_QSTR_encode_packet, MP_OBJ_FROM_PTR(&encode_packet_obj));
    mp_store_global(MP_QSTR_decode_message, MP_OBJ_FROM_PTR(&decode_message_obj));
    mp_store_global(MP_QSTR_parse_xpp, MP_OBJ_FROM_PTR(&parse_xpp_obj));
    MP_DYNRUNTIME_INIT_EXIT
}
