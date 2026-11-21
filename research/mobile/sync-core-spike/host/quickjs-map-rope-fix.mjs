// A local fix for QuickJS-ng 0.18.0's Map/Set hashing of rope strings
// (host/map-rope-repro.js; still in the engine's master on 2026-11-20).
// The engine hashes a rope leaf by leaf, each leaf closed with its own
// length, and mixes in the rope's tag — so an equal flat string lands in
// another bucket and is not found. Here a rope hashes as the same characters
// in one string would: one running hash over the leaves, the total length,
// the string tag.
//
// build-host.mjs applies it to a copy of the amalgamated source (never to
// vendor/ itself); `--stock` builds the engine as released.

const HELPER = `
static uint32_t curator_hash_rope_chars(JSValueConst val, uint32_t h, uint32_t *plen)
{
    if (JS_VALUE_GET_TAG(val) == JS_TAG_STRING) {
        JSString *p = JS_VALUE_GET_STRING(val);
        uint32_t i;
        if (p->is_wide_char) {
            for(i = 0; i < p->len; i++)
                h = h * 263 + str16(p)[i];
        } else {
            for(i = 0; i < p->len; i++)
                h = h * 263 + str8(p)[i];
        }
        *plen += p->len;
        return h;
    } else {
        JSStringRope *r = JS_VALUE_GET_STRING_ROPE(val);
        h = curator_hash_rope_chars(r->left, h, plen);
        return curator_hash_rope_chars(r->right, h, plen);
    }
}

static uint32_t map_hash_key(JSContext *ctx, JSValueConst key)
`;

const STOCK_CASE = `    case JS_TAG_STRING_ROPE:
        h = hash_string_rope(key, 0);
        break;
    case JS_TAG_OBJECT:
    case JS_TAG_SYMBOL:
        h = (uintptr_t)JS_VALUE_GET_PTR(key) * 3163;`;

const FIXED_CASE = `    case JS_TAG_STRING_ROPE:
        {
            uint32_t n = 0;
            h = curator_hash_rope_chars(key, 0, &n) ^ hash32(n);
            tag = JS_TAG_STRING;
        }
        break;
    case JS_TAG_OBJECT:
    case JS_TAG_SYMBOL:
        h = (uintptr_t)JS_VALUE_GET_PTR(key) * 3163;`;

export function fixMapRopeHash(source) {
	const src = source.replace(/\r\n/g, '\n');
	const head = '\nstatic uint32_t map_hash_key(JSContext *ctx, JSValueConst key)\n';
	if (src.split(head).length !== 2 || src.split(STOCK_CASE).length !== 2) throw new Error('this QuickJS source is not the one the fix was written for (0.18.0): build with --stock, or check whether the engine fixed it');
	return src.replace(head, HELPER).replace(STOCK_CASE, FIXED_CASE);
}
