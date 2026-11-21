// The spike's host: QuickJS and SQLite in one process, the way a phone app's
// native library would hold them. JavaScript sees one global, `__host`: a
// SQLite binding shaped for the better-sqlite3 shim (shim/better-sqlite3.ts),
// SHA-1 and SHA-256, gzip, files, a plain HTTP request, clocks and memory figures. No JNI, no threads: a command-line
// program run under `adb shell`, so the numbers are the engine's own.
//
//   host core.js [more.js ...] -- <args for the script>
//
// Value mapping follows better-sqlite3, because the fold must write the same
// bytes the desktop writes:
//   bind   number that is an int32 -> INTEGER, any other number -> REAL,
//          string -> TEXT (a lone surrogate becomes U+FFFD, as V8 writes it),
//          bigint -> INTEGER, typed array -> BLOB, null/undefined -> NULL;
//   read   INTEGER/REAL -> number, TEXT -> string, BLOB -> Buffer, NULL -> null.

#define _GNU_SOURCE
#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include "quickjs.h"
#include "sqlite3.h"
#ifdef SPIKE_ZLIB
#include <zlib.h>
#endif

// ── SHA-1 ────────────────────────────────────────────────────────────────────

typedef struct { uint32_t h[5]; uint64_t len; uint8_t buf[64]; size_t n; } Sha1;

static void sha1_block(Sha1 *s, const uint8_t *p) {
	uint32_t w[80], a, b, c, d, e, t;
	int i;
	for (i = 0; i < 16; i++) w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
	for (i = 16; i < 80; i++) { t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = t << 1 | t >> 31; }
	a = s->h[0]; b = s->h[1]; c = s->h[2]; d = s->h[3]; e = s->h[4];
	for (i = 0; i < 80; i++) {
		uint32_t f, k;
		if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
		else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
		else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
		else { f = b ^ c ^ d; k = 0xCA62C1D6; }
		t = (a << 5 | a >> 27) + f + e + k + w[i];
		e = d; d = c; c = b << 30 | b >> 2; b = a; a = t;
	}
	s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e;
}

static void sha1_init(Sha1 *s) {
	s->h[0] = 0x67452301; s->h[1] = 0xEFCDAB89; s->h[2] = 0x98BADCFE; s->h[3] = 0x10325476; s->h[4] = 0xC3D2E1F0;
	s->len = 0; s->n = 0;
}

static void sha1_update(Sha1 *s, const uint8_t *p, size_t len) {
	s->len += len;
	while (len > 0) {
		if (s->n == 0 && len >= 64) { sha1_block(s, p); p += 64; len -= 64; continue; }
		size_t take = 64 - s->n < len ? 64 - s->n : len;
		memcpy(s->buf + s->n, p, take);
		s->n += take; p += take; len -= take;
		if (s->n == 64) { sha1_block(s, s->buf); s->n = 0; }
	}
}

static void sha1_final(Sha1 *s, uint8_t out[20]) {
	uint64_t bits = s->len * 8;
	uint8_t pad = 0x80, zero = 0, lenb[8];
	int i;
	sha1_update(s, &pad, 1);
	while (s->n != 56) sha1_update(s, &zero, 1);
	for (i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
	sha1_update(s, lenb, 8);
	for (i = 0; i < 5; i++) { out[4 * i] = s->h[i] >> 24; out[4 * i + 1] = s->h[i] >> 16; out[4 * i + 2] = s->h[i] >> 8; out[4 * i + 3] = s->h[i]; }
}

// ── SHA-256 ──────────────────────────────────────────────────────────────────

typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } Sha256;

static const uint32_t K256[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) ((x) >> (n) | (x) << (32 - (n)))

static void sha256_block(Sha256 *s, const uint8_t *p) {
	uint32_t w[64], v[8], t1, t2;
	int i;
	for (i = 0; i < 16; i++) w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
	for (i = 16; i < 64; i++) w[i] = (ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ w[i - 2] >> 10) + w[i - 7] + (ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ w[i - 15] >> 3) + w[i - 16];
	memcpy(v, s->h, sizeof v);
	for (i = 0; i < 64; i++) {
		t1 = v[7] + (ROR(v[4], 6) ^ ROR(v[4], 11) ^ ROR(v[4], 25)) + ((v[4] & v[5]) ^ (~v[4] & v[6])) + K256[i] + w[i];
		t2 = (ROR(v[0], 2) ^ ROR(v[0], 13) ^ ROR(v[0], 22)) + ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
		v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1; v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
	}
	for (i = 0; i < 8; i++) s->h[i] += v[i];
}

static void sha256_init(Sha256 *s) {
	static const uint32_t h0[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
	memcpy(s->h, h0, sizeof h0);
	s->len = 0; s->n = 0;
}

static void sha256_update(Sha256 *s, const uint8_t *p, size_t len) {
	s->len += len;
	while (len > 0) {
		if (s->n == 0 && len >= 64) { sha256_block(s, p); p += 64; len -= 64; continue; }
		size_t take = 64 - s->n < len ? 64 - s->n : len;
		memcpy(s->buf + s->n, p, take);
		s->n += take; p += take; len -= take;
		if (s->n == 64) { sha256_block(s, s->buf); s->n = 0; }
	}
}

static void sha256_final(Sha256 *s, uint8_t out[32]) {
	uint64_t bits = s->len * 8;
	uint8_t pad = 0x80, zero = 0, lenb[8];
	int i;
	sha256_update(s, &pad, 1);
	while (s->n != 56) sha256_update(s, &zero, 1);
	for (i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
	sha256_update(s, lenb, 8);
	for (i = 0; i < 8; i++) { out[4 * i] = s->h[i] >> 24; out[4 * i + 1] = s->h[i] >> 16; out[4 * i + 2] = s->h[i] >> 8; out[4 * i + 3] = s->h[i]; }
}

// ── values ───────────────────────────────────────────────────────────────────

static JSClassID db_class, stmt_class, inflate_class;
static JSValue blob_wrap;	// JS: Uint8Array -> Buffer

// QuickJS writes a lone surrogate as its three-byte form (ED A0..BF xx); V8,
// and so better-sqlite3 and node:crypto, write U+FFFD. Returns `p` itself
// when the string holds none, else a malloc'd copy the caller frees.
static const char *utf8_like_v8(const char *p, size_t len, char **owned) {
	*owned = NULL;
	const char *q = memchr(p, 0xED, len);
	while (q && !(q + 1 < p + len && ((uint8_t)q[1] & 0xE0) == 0xA0)) q = memchr(q + 1, 0xED, (size_t)(p + len - q - 1));
	if (!q) return p;
	char *out = malloc(len + 1);
	memcpy(out, p, len + 1);
	for (size_t i = 0; i + 2 < len; i++) {
		if ((uint8_t)out[i] == 0xED && ((uint8_t)out[i + 1] & 0xE0) == 0xA0) { out[i] = (char)0xEF; out[i + 1] = (char)0xBF; out[i + 2] = (char)0xBD; i += 2; }
	}
	*owned = out;
	return out;
}

// The bytes of a typed array or an ArrayBuffer; NULL (exception pending) otherwise.
static uint8_t *bytes_of(JSContext *ctx, JSValueConst v, size_t *len) {
	size_t off = 0, n = 0, bpe = 0, total = 0;
	JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &n, &bpe);
	if (JS_IsException(ab)) {
		JS_FreeValue(ctx, JS_GetException(ctx));
		uint8_t *p = JS_GetArrayBuffer(ctx, len, v);
		return p;
	}
	uint8_t *p = JS_GetArrayBuffer(ctx, &total, ab);
	JS_FreeValue(ctx, ab);
	if (!p) { if (n == 0) { static uint8_t none; *len = 0; return &none; } return NULL; }
	*len = n;
	return p + off;
}

static JSValue throw_sqlite(JSContext *ctx, sqlite3 *db, int rc) {
	JSValue e = JS_NewError(ctx);
	JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, db ? sqlite3_errmsg(db) : sqlite3_errstr(rc)), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, e, "name", JS_NewString(ctx, "SqliteError"), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, e, "errcode", JS_NewInt32(ctx, db ? sqlite3_extended_errcode(db) : rc), JS_PROP_C_W_E);
	return JS_Throw(ctx, e);
}

// ── SQLite ───────────────────────────────────────────────────────────────────

typedef struct HostStmt HostStmt;
typedef struct { sqlite3 *db; HostStmt *stmts; } HostDb;
struct HostStmt {
	sqlite3_stmt *st;
	HostDb *owner;
	HostStmt *prev, *next;
	int ncol;
	JSAtom *cols;
};

static void stmt_release(HostStmt *hs) {
	if (hs->st) { sqlite3_finalize(hs->st); hs->st = NULL; }
	if (hs->owner) {
		if (hs->prev) hs->prev->next = hs->next; else hs->owner->stmts = hs->next;
		if (hs->next) hs->next->prev = hs->prev;
		hs->owner = NULL;
	}
}

// better-sqlite3's close: every statement of the connection is finalized, so
// the file is really closed (and the WAL checkpointed) when this returns.
static void db_release(HostDb *hd) {
	while (hd->stmts) stmt_release(hd->stmts);
	if (hd->db) { sqlite3_close(hd->db); hd->db = NULL; }
}

static void stmt_finalizer(JSRuntime *rt, JSValueConst val) {
	HostStmt *hs = JS_GetOpaque(val, stmt_class);
	if (!hs) return;
	stmt_release(hs);
	for (int i = 0; i < hs->ncol; i++) JS_FreeAtomRT(rt, hs->cols[i]);
	free(hs->cols);
	free(hs);
}

static void db_finalizer(JSRuntime *rt, JSValueConst val) {
	HostDb *hd = JS_GetOpaque(val, db_class);
	(void)rt;
	if (!hd) return;
	db_release(hd);
	free(hd);
}

static HostDb *get_db(JSContext *ctx, JSValueConst v) {
	HostDb *hd = JS_GetOpaque2(ctx, v, db_class);
	if (hd && !hd->db) { JS_ThrowTypeError(ctx, "The database connection is not open"); return NULL; }
	return hd;
}

static HostStmt *get_stmt(JSContext *ctx, JSValueConst v) {
	HostStmt *hs = JS_GetOpaque2(ctx, v, stmt_class);
	if (hs && !hs->st) { JS_ThrowTypeError(ctx, "The database connection is not open"); return NULL; }
	return hs;
}

static JSValue js_db_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	int readonly = JS_ToBool(ctx, argv[1]), must_exist = JS_ToBool(ctx, argv[2]);
	int flags = (readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | (must_exist ? 0 : SQLITE_OPEN_CREATE)) | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_URI;
	sqlite3 *db = NULL;
	int rc = sqlite3_open_v2(path, &db, flags, NULL);
	JS_FreeCString(ctx, path);
	if (rc != SQLITE_OK) {
		JSValue e = throw_sqlite(ctx, db, rc);
		sqlite3_close(db);
		return e;
	}
	sqlite3_extended_result_codes(db, 1);
	sqlite3_busy_timeout(db, 5000);
	HostDb *hd = calloc(1, sizeof *hd);
	hd->db = db;
	JSValue obj = JS_NewObjectClass(ctx, db_class);
	JS_SetOpaque(obj, hd);
	return obj;
}

static JSValue js_db_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostDb *hd = JS_GetOpaque2(ctx, argv[0], db_class);
	if (!hd) return JS_EXCEPTION;
	db_release(hd);
	return JS_UNDEFINED;
}

static JSValue js_db_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostDb *hd = get_db(ctx, argv[0]);
	if (!hd) return JS_EXCEPTION;
	const char *sql = JS_ToCString(ctx, argv[1]);
	if (!sql) return JS_EXCEPTION;
	int rc = sqlite3_exec(hd->db, sql, NULL, NULL, NULL);
	JS_FreeCString(ctx, sql);
	return rc == SQLITE_OK ? JS_UNDEFINED : throw_sqlite(ctx, hd->db, rc);
}

static JSValue js_db_autocommit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostDb *hd = get_db(ctx, argv[0]);
	if (!hd) return JS_EXCEPTION;
	return JS_NewBool(ctx, sqlite3_get_autocommit(hd->db) != 0);
}

// Whether anything but whitespace, `;` and comments follows the statement.
static bool has_more_sql(const char *p) {
	for (;;) {
		while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == '\f' || *p == ';') p++;
		if (p[0] == '-' && p[1] == '-') { while (*p && *p != '\n') p++; continue; }
		if (p[0] == '/' && p[1] == '*') { p += 2; while (*p && !(p[0] == '*' && p[1] == '/')) p++; if (*p) p += 2; continue; }
		return *p != 0;
	}
}

// -> [statement, returnsRows, parameterNames]; a name is null for a plain `?`.
static JSValue js_db_prepare(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostDb *hd = get_db(ctx, argv[0]);
	if (!hd) return JS_EXCEPTION;
	size_t len;
	const char *sql = JS_ToCStringLen(ctx, &len, argv[1]);
	if (!sql) return JS_EXCEPTION;
	sqlite3_stmt *st = NULL;
	const char *tail = NULL;
	int rc = sqlite3_prepare_v2(hd->db, sql, (int)len + 1, &st, &tail);
	if (rc != SQLITE_OK) { JS_FreeCString(ctx, sql); return throw_sqlite(ctx, hd->db, rc); }
	bool more = st && tail && has_more_sql(tail);
	JS_FreeCString(ctx, sql);
	if (!st) return JS_ThrowRangeError(ctx, "The supplied SQL string contains no statements");
	if (more) { sqlite3_finalize(st); return JS_ThrowRangeError(ctx, "The supplied SQL string contains more than one statement"); }

	HostStmt *hs = calloc(1, sizeof *hs);
	hs->st = st;
	hs->owner = hd;
	hs->next = hd->stmts;
	if (hd->stmts) hd->stmts->prev = hs;
	hd->stmts = hs;
	hs->ncol = sqlite3_column_count(st);
	hs->cols = calloc(hs->ncol ? hs->ncol : 1, sizeof(JSAtom));
	for (int i = 0; i < hs->ncol; i++) hs->cols[i] = JS_NewAtom(ctx, sqlite3_column_name(st, i));
	JSValue obj = JS_NewObjectClass(ctx, stmt_class);
	JS_SetOpaque(obj, hs);

	int np = sqlite3_bind_parameter_count(st);
	JSValue names = JS_NewArray(ctx);
	for (int i = 0; i < np; i++) {
		const char *n = sqlite3_bind_parameter_name(st, i + 1);
		JS_SetPropertyUint32(ctx, names, i, n ? JS_NewString(ctx, n) : JS_NULL);
	}
	JSValue out = JS_NewArray(ctx);
	JS_SetPropertyUint32(ctx, out, 0, obj);
	JS_SetPropertyUint32(ctx, out, 1, JS_NewBool(ctx, hs->ncol > 0));
	JS_SetPropertyUint32(ctx, out, 2, names);
	return out;
}

static int bind_all(JSContext *ctx, HostStmt *hs, JSValueConst params) {
	sqlite3_stmt *st = hs->st;
	int want = sqlite3_bind_parameter_count(st);
	int64_t have = 0;
	if (!JS_IsUndefined(params) && !JS_IsNull(params) && JS_GetLength(ctx, params, &have)) return -1;
	if (have != want) {
		JS_ThrowRangeError(ctx, have < want ? "Too few parameter values were provided" : "Too many parameter values were provided");
		return -1;
	}
	for (int i = 0; i < want; i++) {
		JSValue v = JS_GetPropertyUint32(ctx, params, (uint32_t)i);
		int rc;
		if (JS_IsException(v)) return -1;
		if (JS_IsNumber(v)) {
			double d;
			JS_ToFloat64(ctx, &d, v);
			if (d >= -2147483648.0 && d <= 2147483647.0 && d == floor(d) && !(d == 0 && signbit(d))) rc = sqlite3_bind_int(st, i + 1, (int)d);
			else rc = sqlite3_bind_double(st, i + 1, d);
		} else if (JS_IsString(v)) {
			size_t len;
			char *owned;
			const char *raw = JS_ToCStringLen(ctx, &len, v);
			if (!raw) { JS_FreeValue(ctx, v); return -1; }
			const char *p = utf8_like_v8(raw, len, &owned);
			rc = sqlite3_bind_text(st, i + 1, p, (int)len, SQLITE_TRANSIENT);
			free(owned);
			JS_FreeCString(ctx, raw);
		} else if (JS_IsNull(v) || JS_IsUndefined(v)) {
			rc = sqlite3_bind_null(st, i + 1);
		} else if (JS_IsBigInt(v)) {
			int64_t x;
			JS_ToBigInt64(ctx, &x, v);
			rc = sqlite3_bind_int64(st, i + 1, x);
		} else {
			size_t len = 0;
			uint8_t *p = JS_IsObject(v) ? bytes_of(ctx, v, &len) : NULL;
			if (!p) {
				if (JS_IsObject(v)) JS_FreeValue(ctx, JS_GetException(ctx));
				JS_FreeValue(ctx, v);
				JS_ThrowTypeError(ctx, "SQLite3 can only bind numbers, strings, bigints, buffers, and null");
				return -1;
			}
			rc = sqlite3_bind_blob(st, i + 1, p, (int)len, SQLITE_TRANSIENT);
		}
		JS_FreeValue(ctx, v);
		if (rc != SQLITE_OK) { throw_sqlite(ctx, sqlite3_db_handle(st), rc); return -1; }
	}
	return 0;
}

static JSValue col_value(JSContext *ctx, sqlite3_stmt *st, int i) {
	switch (sqlite3_column_type(st, i)) {
		case SQLITE_INTEGER: return JS_NewInt64(ctx, sqlite3_column_int64(st, i));
		case SQLITE_FLOAT: return JS_NewFloat64(ctx, sqlite3_column_double(st, i));
		case SQLITE_TEXT: return JS_NewStringLen(ctx, (const char *)sqlite3_column_text(st, i), (size_t)sqlite3_column_bytes(st, i));
		case SQLITE_BLOB: {
			const uint8_t *p = sqlite3_column_blob(st, i);
			static const uint8_t none = 0;
			JSValue u = JS_NewUint8ArrayCopy(ctx, p ? p : &none, (size_t)sqlite3_column_bytes(st, i));
			if (JS_IsException(u) || JS_IsUndefined(blob_wrap)) return u;
			JSValue b = JS_Call(ctx, blob_wrap, JS_UNDEFINED, 1, (JSValueConst *)&u);
			JS_FreeValue(ctx, u);
			return b;
		}
		default: return JS_NULL;
	}
}

// mode 0: an object keyed by column; 1: the first column alone (pluck); 2: an array (raw).
static JSValue read_row(JSContext *ctx, HostStmt *hs, int mode) {
	if (mode == 1) return col_value(ctx, hs->st, 0);
	JSValue row = mode == 2 ? JS_NewArray(ctx) : JS_NewObject(ctx);
	for (int i = 0; i < hs->ncol; i++) {
		JSValue v = col_value(ctx, hs->st, i);
		if (JS_IsException(v)) { JS_FreeValue(ctx, row); return v; }
		if (mode == 2) JS_SetPropertyUint32(ctx, row, (uint32_t)i, v);
		else JS_DefinePropertyValue(ctx, row, hs->cols[i], v, JS_PROP_C_W_E);
	}
	return row;
}

static JSValue js_stmt_run(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostStmt *hs = get_stmt(ctx, argv[0]);
	if (!hs || bind_all(ctx, hs, argv[1])) return JS_EXCEPTION;
	sqlite3 *db = sqlite3_db_handle(hs->st);
	int before = sqlite3_total_changes(db);
	while (sqlite3_step(hs->st) == SQLITE_ROW) {}
	int rc = sqlite3_reset(hs->st);
	if (rc != SQLITE_OK) return throw_sqlite(ctx, db, rc);
	JSValue info = JS_NewObject(ctx);
	JS_DefinePropertyValueStr(ctx, info, "changes", JS_NewInt32(ctx, sqlite3_total_changes(db) == before ? 0 : sqlite3_changes(db)), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, info, "lastInsertRowid", JS_NewInt64(ctx, sqlite3_last_insert_rowid(db)), JS_PROP_C_W_E);
	return info;
}

static JSValue js_stmt_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostStmt *hs = get_stmt(ctx, argv[0]);
	int mode;
	if (!hs || bind_all(ctx, hs, argv[1]) || JS_ToInt32(ctx, &mode, argv[2])) return JS_EXCEPTION;
	sqlite3 *db = sqlite3_db_handle(hs->st);
	JSValue row = JS_UNDEFINED;
	if (sqlite3_step(hs->st) == SQLITE_ROW) row = read_row(ctx, hs, mode);
	int rc = sqlite3_reset(hs->st);
	if (rc != SQLITE_OK) { JS_FreeValue(ctx, row); return throw_sqlite(ctx, db, rc); }
	return row;
}

static JSValue js_stmt_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostStmt *hs = get_stmt(ctx, argv[0]);
	int mode;
	if (!hs || bind_all(ctx, hs, argv[1]) || JS_ToInt32(ctx, &mode, argv[2])) return JS_EXCEPTION;
	sqlite3 *db = sqlite3_db_handle(hs->st);
	JSValue rows = JS_NewArray(ctx);
	uint32_t n = 0;
	while (sqlite3_step(hs->st) == SQLITE_ROW) {
		JSValue row = read_row(ctx, hs, mode);
		if (JS_IsException(row)) { sqlite3_reset(hs->st); JS_FreeValue(ctx, rows); return row; }
		JS_SetPropertyUint32(ctx, rows, n++, row);
	}
	int rc = sqlite3_reset(hs->st);
	if (rc != SQLITE_OK) { JS_FreeValue(ctx, rows); return throw_sqlite(ctx, db, rc); }
	return rows;
}

// iterate(): bind, then one row a call; `undefined` once the rows are out.
static JSValue js_stmt_iter_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostStmt *hs = get_stmt(ctx, argv[0]);
	if (!hs || bind_all(ctx, hs, argv[1])) return JS_EXCEPTION;
	return JS_UNDEFINED;
}

static JSValue js_stmt_iter_next(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostStmt *hs = get_stmt(ctx, argv[0]);
	int mode;
	if (!hs || JS_ToInt32(ctx, &mode, argv[1])) return JS_EXCEPTION;
	if (sqlite3_step(hs->st) == SQLITE_ROW) return read_row(ctx, hs, mode);
	sqlite3 *db = sqlite3_db_handle(hs->st);
	int rc = sqlite3_reset(hs->st);
	return rc == SQLITE_OK ? JS_UNDEFINED : throw_sqlite(ctx, db, rc);
}

static JSValue js_stmt_reset(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	HostStmt *hs = JS_GetOpaque2(ctx, argv[0], stmt_class);
	if (!hs) return JS_EXCEPTION;
	if (hs->st) sqlite3_reset(hs->st);
	return JS_UNDEFINED;
}

// ── hashing, files, clocks, memory ───────────────────────────────────────────

// hash(parts, hex, bits): SHA-1 (bits 160) or SHA-256 (256) of the parts in
// order; a part is a string (hashed as UTF-8) or a typed array.
static JSValue js_hash(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int64_t n;
	int32_t bits = 160;
	if (JS_GetLength(ctx, argv[0], &n) || JS_ToInt32(ctx, &bits, argv[2])) return JS_EXCEPTION;
	bool wide = bits == 256;
	Sha1 s;
	Sha256 s2;
	sha1_init(&s);
	sha256_init(&s2);
	for (int64_t i = 0; i < n; i++) {
		JSValue v = JS_GetPropertyUint32(ctx, argv[0], (uint32_t)i);
		if (JS_IsException(v)) return v;
		size_t len = 0;
		if (JS_IsString(v)) {
			char *owned;
			const char *raw = JS_ToCStringLen(ctx, &len, v);
			if (!raw) { JS_FreeValue(ctx, v); return JS_EXCEPTION; }
			const uint8_t *p = (const uint8_t *)utf8_like_v8(raw, len, &owned);
			if (wide) sha256_update(&s2, p, len); else sha1_update(&s, p, len);
			free(owned);
			JS_FreeCString(ctx, raw);
		} else {
			uint8_t *p = bytes_of(ctx, v, &len);
			if (!p) { JS_FreeValue(ctx, v); return JS_EXCEPTION; }
			if (wide) sha256_update(&s2, p, len); else sha1_update(&s, p, len);
		}
		JS_FreeValue(ctx, v);
	}
	uint8_t out[32];
	size_t size = wide ? 32 : 20;
	if (wide) sha256_final(&s2, out); else sha1_final(&s, out);
	if (!JS_ToBool(ctx, argv[1])) return JS_NewUint8ArrayCopy(ctx, out, size);
	char hex[65];
	for (size_t i = 0; i < size; i++) snprintf(hex + 2 * i, 3, "%02x", out[i]);
	return JS_NewStringLen(ctx, hex, 2 * size);
}

static uint8_t *read_file(JSContext *ctx, const char *path, size_t *len) {
	FILE *f = fopen(path, "rb");
	if (!f) { JS_ThrowPlainError(ctx, "cannot open %s: %s", path, strerror(errno)); return NULL; }
	fseeko(f, 0, SEEK_END);
	off_t size = ftello(f);
	fseeko(f, 0, SEEK_SET);
	uint8_t *buf = malloc((size_t)size + 1);
	if (!buf || fread(buf, 1, (size_t)size, f) != (size_t)size) {
		fclose(f);
		free(buf);
		JS_ThrowPlainError(ctx, "cannot read %s (%lld bytes)", path, (long long)size);
		return NULL;
	}
	fclose(f);
	buf[size] = 0;
	*len = (size_t)size;
	return buf;
}

// QuickJS's hook for a buffer it did not allocate: size 0 frees it.
static void *host_buffer(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
	(void)rt; (void)opaque;
	if (size == 0) { free(ptr); return NULL; }
	return realloc(ptr, size);
}

static JSValue js_read_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	size_t len;
	uint8_t *buf = read_file(ctx, path, &len);
	JS_FreeCString(ctx, path);
	if (!buf) return JS_EXCEPTION;
	JSValue s = JS_NewStringLen(ctx, (const char *)buf, len);
	free(buf);
	return s;
}

// -> ArrayBuffer owning the file's bytes (no second copy).
static JSValue js_read_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	size_t len;
	uint8_t *buf = read_file(ctx, path, &len);
	JS_FreeCString(ctx, path);
	if (!buf) return JS_EXCEPTION;
	return JS_NewArrayBuffer(ctx, buf, len, 0, host_buffer, NULL, false);
}

static JSValue js_write_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	size_t len;
	const char *text = JS_ToCStringLen(ctx, &len, argv[1]);
	if (!path || !text) return JS_EXCEPTION;
	FILE *f = fopen(path, "wb");
	bool ok = f && fwrite(text, 1, len, f) == len;
	if (f) fclose(f);
	JSValue r = ok ? JS_UNDEFINED : JS_ThrowPlainError(ctx, "cannot write %s: %s", path, strerror(errno));
	JS_FreeCString(ctx, path);
	JS_FreeCString(ctx, text);
	return r;
}

static JSValue js_utf8_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len;
	uint8_t *p = bytes_of(ctx, argv[0], &len);
	if (!p) return JS_EXCEPTION;
	return JS_NewStringLen(ctx, (const char *)p, len);
}

static JSValue js_utf8_encode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len;
	char *owned;
	const char *raw = JS_ToCStringLen(ctx, &len, argv[0]);
	if (!raw) return JS_EXCEPTION;
	JSValue out = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)utf8_like_v8(raw, len, &owned), len);
	free(owned);
	JS_FreeCString(ctx, raw);
	return out;
}

// A gzip body inflated a piece at a time (inflateOpen / inflateRead): the
// snapshot's text is a quarter of a gigabyte and is never held whole.
typedef struct {
#ifdef SPIKE_ZLIB
	z_stream z;
#endif
	uint8_t *in;
	bool done;
} HostInflate;

static void inflate_finalizer(JSRuntime *rt, JSValueConst val) {
	HostInflate *hi = JS_GetOpaque(val, inflate_class);
	(void)rt;
	if (!hi) return;
#ifdef SPIKE_ZLIB
	inflateEnd(&hi->z);
#endif
	free(hi->in);
	free(hi);
}

static JSValue js_inflate_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
#ifdef SPIKE_ZLIB
	size_t len;
	uint8_t *in = bytes_of(ctx, argv[0], &len);
	if (!in) return JS_EXCEPTION;
	HostInflate *hi = calloc(1, sizeof *hi);
	hi->in = malloc(len ? len : 1);
	memcpy(hi->in, in, len);
	if (inflateInit2(&hi->z, 16 + MAX_WBITS) != Z_OK) { free(hi->in); free(hi); return JS_ThrowPlainError(ctx, "inflateInit2 failed"); }
	hi->z.next_in = hi->in;
	hi->z.avail_in = (uInt)len;
	JSValue obj = JS_NewObjectClass(ctx, inflate_class);
	JS_SetOpaque(obj, hi);
	return obj;
#else
	return JS_ThrowPlainError(ctx, "this host was built without zlib");
#endif
}

// -> ArrayBuffer of up to `max` inflated bytes, or null once the body is out.
static JSValue js_inflate_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
#ifdef SPIKE_ZLIB
	HostInflate *hi = JS_GetOpaque2(ctx, argv[0], inflate_class);
	int32_t max;
	if (!hi || JS_ToInt32(ctx, &max, argv[1])) return JS_EXCEPTION;
	if (hi->done) return JS_NULL;
	uint8_t *out = malloc((size_t)max);
	hi->z.next_out = out;
	hi->z.avail_out = (uInt)max;
	while (hi->z.avail_out > 0 && !hi->done) {
		int rc = inflate(&hi->z, Z_NO_FLUSH);
		if (rc == Z_STREAM_END) hi->done = true;
		else if (rc != Z_OK || (hi->z.avail_in == 0 && hi->z.avail_out > 0)) { free(out); return JS_ThrowPlainError(ctx, "inflate failed (%d)", rc); }
	}
	size_t n = (size_t)max - hi->z.avail_out;
	if (n == 0) { free(out); return JS_NULL; }
	return JS_NewArrayBuffer(ctx, realloc(out, n), n, 0, host_buffer, NULL, false);
#else
	return JS_ThrowPlainError(ctx, "this host was built without zlib");
#endif
}

// gzip body -> ArrayBuffer of the inflated bytes.
static JSValue js_gunzip(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
#ifdef SPIKE_ZLIB
	size_t len;
	uint8_t *in = bytes_of(ctx, argv[0], &len);
	if (!in) return JS_EXCEPTION;
	z_stream z;
	memset(&z, 0, sizeof z);
	if (inflateInit2(&z, 16 + MAX_WBITS) != Z_OK) return JS_ThrowPlainError(ctx, "inflateInit2 failed");
	size_t cap = len * 6 + 65536, n = 0;
	uint8_t *out = malloc(cap);
	z.next_in = in;
	z.avail_in = (uInt)len;
	int rc = Z_OK;
	while (rc != Z_STREAM_END) {
		if (n == cap) { cap += cap / 2; out = realloc(out, cap); }
		size_t room = cap - n;
		z.next_out = out + n;
		z.avail_out = room > 0x40000000 ? 0x40000000 : (uInt)room;
		uInt gave = z.avail_out;
		rc = inflate(&z, Z_NO_FLUSH);
		n += gave - z.avail_out;
		if (rc != Z_OK && rc != Z_STREAM_END) { inflateEnd(&z); free(out); return JS_ThrowPlainError(ctx, "inflate failed (%d)", rc); }
	}
	inflateEnd(&z);
	out = realloc(out, n ? n : 1);
	return JS_NewArrayBuffer(ctx, out, n, 0, host_buffer, NULL, false);
#else
	return JS_ThrowPlainError(ctx, "this host was built without zlib");
#endif
}

// One HTTP/1.1 request over a plain socket, the connection closed after it:
// http(method, host, port, path, headerLines, body|null) -> { status, body }.
// For the test server on this machine (through `adb reverse` on a phone);
// a real app's HTTP is the platform's, with TLS.
static JSValue js_http(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *method = JS_ToCString(ctx, argv[0]);
	const char *host = JS_ToCString(ctx, argv[1]);
	const char *path = JS_ToCString(ctx, argv[3]);
	const char *lines = JS_ToCString(ctx, argv[4]);
	int32_t port = 80;
	size_t body_len = 0;
	const char *body = JS_IsNull(argv[5]) || JS_IsUndefined(argv[5]) ? NULL : JS_ToCStringLen(ctx, &body_len, argv[5]);
	JSValue out = JS_EXCEPTION;
	uint8_t *buf = NULL;
	int fd = -1;
	if (!method || !host || !path || !lines || JS_ToInt32(ctx, &port, argv[2])) goto done;

	char service[16];
	snprintf(service, sizeof service, "%d", port);
	struct addrinfo hints, *found = NULL;
	memset(&hints, 0, sizeof hints);
	hints.ai_socktype = SOCK_STREAM;
	if (getaddrinfo(host, service, &hints, &found) != 0 || !found) { JS_ThrowPlainError(ctx, "cannot resolve %s", host); goto done; }
	for (struct addrinfo *a = found; a && fd < 0; a = a->ai_next) {
		fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
		if (fd >= 0 && connect(fd, a->ai_addr, a->ai_addrlen) != 0) { close(fd); fd = -1; }
	}
	freeaddrinfo(found);
	if (fd < 0) { JS_ThrowPlainError(ctx, "cannot connect to %s:%d: %s", host, port, strerror(errno)); goto done; }

	size_t head_cap = strlen(method) + strlen(path) + strlen(host) + strlen(lines) + 128;
	char *head = malloc(head_cap);
	int head_len = snprintf(head, head_cap, "%s %s HTTP/1.1\r\nHost: %s:%d\r\nConnection: close\r\n%sContent-Length: %zu\r\n\r\n", method, path, host, port, lines, body_len);
	bool sent = true;
	for (size_t off = 0; sent && off < (size_t)head_len;) { ssize_t n = send(fd, head + off, (size_t)head_len - off, 0); if (n <= 0) sent = false; else off += (size_t)n; }
	for (size_t off = 0; sent && off < body_len;) { ssize_t n = send(fd, body + off, body_len - off, 0); if (n <= 0) sent = false; else off += (size_t)n; }
	free(head);
	if (!sent) { JS_ThrowPlainError(ctx, "the request to %s:%d was cut: %s", host, port, strerror(errno)); goto done; }

	size_t cap = 1 << 16, len = 0;
	buf = malloc(cap);
	for (;;) {
		if (len == cap) { cap *= 2; buf = realloc(buf, cap); }
		ssize_t n = recv(fd, buf + len, cap - len, 0);
		if (n < 0) { JS_ThrowPlainError(ctx, "the answer from %s:%d was cut: %s", host, port, strerror(errno)); goto done; }
		if (n == 0) break;
		len += (size_t)n;
	}
	// "HTTP/1.1 200 …", headers, a blank line, the body.
	uint8_t *split = len >= 4 ? memmem(buf, len, "\r\n\r\n", 4) : NULL;
	int status = 0;
	if (!split || len < 12 || sscanf((const char *)buf, "HTTP/%*d.%*d %d", &status) != 1) { JS_ThrowPlainError(ctx, "not an HTTP answer from %s:%d", host, port); goto done; }
	size_t head_bytes = (size_t)(split - buf) + 4;
	uint8_t *payload = buf + head_bytes;
	size_t payload_len = len - head_bytes;
	// A chunked body (no Content-Length from the server): the chunks joined in place.
	*split = 0;
	bool chunked = false;
	for (char *p = (char *)buf; *p; p++) if (strncasecmp(p, "transfer-encoding: chunked", 26) == 0) { chunked = true; break; }
	if (chunked) {
		size_t r = 0, w = 0;
		while (r < payload_len) {
			size_t size = strtoul((const char *)payload + r, NULL, 16);
			uint8_t *eol = memmem(payload + r, payload_len - r, "\r\n", 2);
			if (!eol || size == 0) break;
			r = (size_t)(eol - payload) + 2;
			if (r + size > payload_len) break;
			memmove(payload + w, payload + r, size);
			w += size;
			r += size + 2;
		}
		payload_len = w;
	}
	out = JS_NewObject(ctx);
	JS_DefinePropertyValueStr(ctx, out, "status", JS_NewInt32(ctx, status), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, out, "body", JS_NewArrayBufferCopy(ctx, payload, payload_len), JS_PROP_C_W_E);
done:
	if (fd >= 0) close(fd);
	free(buf);
	JS_FreeCString(ctx, method);
	JS_FreeCString(ctx, host);
	JS_FreeCString(ctx, path);
	JS_FreeCString(ctx, lines);
	if (body) JS_FreeCString(ctx, body);
	return out;
}

static JSValue js_print(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len;
	const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
	if (!s) return JS_EXCEPTION;
	fwrite(s, 1, len, stdout);
	fputc('\n', stdout);
	fflush(stdout);
	JS_FreeCString(ctx, s);
	return JS_UNDEFINED;
}

static JSValue js_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return JS_NewFloat64(ctx, floor((double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6));
}

static JSValue js_hrtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return JS_NewFloat64(ctx, (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6);
}

static JSValue js_random_uuid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	uint8_t b[16];
	FILE *f = fopen("/dev/urandom", "rb");
	if (!f || fread(b, 1, 16, f) != 16) { if (f) fclose(f); return JS_ThrowPlainError(ctx, "no /dev/urandom"); }
	fclose(f);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	char s[37];
	snprintf(s, sizeof s, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
	return JS_NewStringLen(ctx, s, 36);
}

static long status_kb(const char *field) {
	FILE *f = fopen("/proc/self/status", "r");
	char line[256];
	long kb = -1;
	size_t n = strlen(field);
	if (!f) return -1;
	while (fgets(line, sizeof line, f)) {
		if (strncmp(line, field, n) == 0 && line[n] == ':') { kb = strtol(line + n + 1, NULL, 10); break; }
	}
	fclose(f);
	return kb;
}

// Resident memory of the process now and at its peak, and the JS heap.
// `deep` walks the heap for the object counts (slow on a large one).
static JSValue js_mem(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValue o = JS_NewObject(ctx);
	JS_DefinePropertyValueStr(ctx, o, "rssKb", JS_NewInt64(ctx, status_kb("VmRSS")), JS_PROP_C_W_E);
	JS_DefinePropertyValueStr(ctx, o, "peakRssKb", JS_NewInt64(ctx, status_kb("VmHWM")), JS_PROP_C_W_E);
	if (argc > 0 && JS_ToBool(ctx, argv[0])) {
		JSMemoryUsage m;
		// What is alive, not what the next collection would free.
		JS_RunGC(JS_GetRuntime(ctx));
		JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &m);
		JS_DefinePropertyValueStr(ctx, o, "jsHeapKb", JS_NewInt64(ctx, m.malloc_size / 1024), JS_PROP_C_W_E);
		JS_DefinePropertyValueStr(ctx, o, "jsObjects", JS_NewInt64(ctx, m.obj_count), JS_PROP_C_W_E);
		JS_DefinePropertyValueStr(ctx, o, "jsStringsKb", JS_NewInt64(ctx, m.str_size / 1024), JS_PROP_C_W_E);
	}
	return o;
}

static JSValue js_gc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JS_RunGC(JS_GetRuntime(ctx));
	return JS_UNDEFINED;
}

static JSValue js_set_blob_wrap(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JS_FreeValue(ctx, blob_wrap);
	blob_wrap = JS_DupValue(ctx, argv[0]);
	return JS_UNDEFINED;
}

static const JSCFunctionListEntry host_funcs[] = {
	JS_CFUNC_DEF("dbOpen", 3, js_db_open),
	JS_CFUNC_DEF("dbClose", 1, js_db_close),
	JS_CFUNC_DEF("dbExec", 2, js_db_exec),
	JS_CFUNC_DEF("dbAutocommit", 1, js_db_autocommit),
	JS_CFUNC_DEF("dbPrepare", 2, js_db_prepare),
	JS_CFUNC_DEF("stmtRun", 2, js_stmt_run),
	JS_CFUNC_DEF("stmtGet", 3, js_stmt_get),
	JS_CFUNC_DEF("stmtAll", 3, js_stmt_all),
	JS_CFUNC_DEF("stmtIterStart", 2, js_stmt_iter_start),
	JS_CFUNC_DEF("stmtIterNext", 2, js_stmt_iter_next),
	JS_CFUNC_DEF("stmtReset", 1, js_stmt_reset),
	JS_CFUNC_DEF("hash", 3, js_hash),
	JS_CFUNC_DEF("readText", 1, js_read_text),
	JS_CFUNC_DEF("readBytes", 1, js_read_bytes),
	JS_CFUNC_DEF("writeText", 2, js_write_text),
	JS_CFUNC_DEF("utf8Decode", 1, js_utf8_decode),
	JS_CFUNC_DEF("utf8Encode", 1, js_utf8_encode),
	JS_CFUNC_DEF("gunzip", 1, js_gunzip),
	JS_CFUNC_DEF("inflateOpen", 1, js_inflate_open),
	JS_CFUNC_DEF("inflateRead", 2, js_inflate_read),
	JS_CFUNC_DEF("http", 6, js_http),
	JS_CFUNC_DEF("print", 1, js_print),
	JS_CFUNC_DEF("now", 0, js_now),
	JS_CFUNC_DEF("hrtime", 0, js_hrtime),
	JS_CFUNC_DEF("randomUUID", 0, js_random_uuid),
	JS_CFUNC_DEF("mem", 1, js_mem),
	JS_CFUNC_DEF("gc", 0, js_gc),
	JS_CFUNC_DEF("setBlobWrap", 1, js_set_blob_wrap),
};

// ── run ──────────────────────────────────────────────────────────────────────

static int failed;

static void dump_error(JSContext *ctx, JSValueConst e) {
	const char *msg = JS_ToCString(ctx, e);
	fprintf(stderr, "%s\n", msg ? msg : "(exception)");
	JS_FreeCString(ctx, msg);
	if (JS_IsError(e)) {
		JSValue stack = JS_GetPropertyStr(ctx, e, "stack");
		const char *s = JS_ToCString(ctx, stack);
		if (s) fprintf(stderr, "%s\n", s);
		JS_FreeCString(ctx, s);
		JS_FreeValue(ctx, stack);
	}
	fflush(stderr);
	failed = 1;
}

// A rejection is reported unhandled first and handled once a catch attaches
// (an async function that throws before its first await): only one still
// unhandled when the run ends is a failure.
static int unhandled;
static JSValue last_unhandled;

static void on_rejection(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool is_handled, void *opaque) {
	(void)promise; (void)opaque;
	if (is_handled) { if (unhandled > 0) unhandled--; return; }
	unhandled++;
	JS_FreeValue(ctx, last_unhandled);
	last_unhandled = JS_DupValue(ctx, reason);
}

int main(int argc, char **argv) {
	JSRuntime *rt = JS_NewRuntime();
	// Zod and drizzle recurse; QuickJS frames live on the C stack.
	JS_SetMaxStackSize(rt, 6 * 1024 * 1024);
	JS_SetHostPromiseRejectionTracker(rt, on_rejection, NULL);
	JSContext *ctx = JS_NewContext(rt);
	blob_wrap = JS_UNDEFINED;
	last_unhandled = JS_UNDEFINED;

	JSClassDef db_def = { "HostDatabase", .finalizer = db_finalizer };
	JSClassDef stmt_def = { "HostStatement", .finalizer = stmt_finalizer };
	JS_NewClassID(rt, &db_class);
	JS_NewClass(rt, db_class, &db_def);
	JS_NewClassID(rt, &stmt_class);
	JS_NewClass(rt, stmt_class, &stmt_def);
	JSClassDef inflate_def = { "HostInflate", .finalizer = inflate_finalizer };
	JS_NewClassID(rt, &inflate_class);
	JS_NewClass(rt, inflate_class, &inflate_def);

	int split = 1;
	while (split < argc && strcmp(argv[split], "--") != 0) split++;

	JSValue global = JS_GetGlobalObject(ctx);
	JSValue host = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, host, host_funcs, sizeof host_funcs / sizeof host_funcs[0]);
	JSValue args = JS_NewArray(ctx);
	for (int i = split + 1; i < argc; i++) JS_SetPropertyUint32(ctx, args, (uint32_t)(i - split - 1), JS_NewString(ctx, argv[i]));
	JS_SetPropertyStr(ctx, host, "args", args);
	JS_SetPropertyStr(ctx, host, "engine", JS_NewString(ctx, JS_GetVersion()));
	JS_SetPropertyStr(ctx, host, "sqlite", JS_NewString(ctx, sqlite3_libversion()));
	JS_SetPropertyStr(ctx, global, "__host", host);

	for (int i = 1; i < split && !failed; i++) {
		size_t len;
		uint8_t *src = read_file(ctx, argv[i], &len);
		if (!src) { JSValue e = JS_GetException(ctx); dump_error(ctx, e); JS_FreeValue(ctx, e); break; }
		JSValue r = JS_Eval(ctx, (const char *)src, len, argv[i], JS_EVAL_TYPE_GLOBAL);
		free(src);
		if (JS_IsException(r)) { JSValue e = JS_GetException(ctx); dump_error(ctx, e); JS_FreeValue(ctx, e); }
		JS_FreeValue(ctx, r);
	}

	// Promise jobs until none is left, then one task (setImmediate, a timer)
	// from the script's own queue; done when both are empty.
	while (!failed) {
		JSContext *c;
		int r;
		while ((r = JS_ExecutePendingJob(rt, &c)) > 0) {}
		if (r < 0) { JSValue e = JS_GetException(c); dump_error(c, e); JS_FreeValue(c, e); break; }
		JSValue tick = JS_GetPropertyStr(ctx, global, "__tick");
		if (!JS_IsFunction(ctx, tick)) { JS_FreeValue(ctx, tick); break; }
		JSValue ran = JS_Call(ctx, tick, JS_UNDEFINED, 0, NULL);
		JS_FreeValue(ctx, tick);
		if (JS_IsException(ran)) { JSValue e = JS_GetException(ctx); dump_error(ctx, e); JS_FreeValue(ctx, e); break; }
		int more = JS_ToBool(ctx, ran);
		JS_FreeValue(ctx, ran);
		if (!more) break;
	}

	if (unhandled > 0) { fprintf(stderr, "unhandled rejection: "); dump_error(ctx, last_unhandled); }
	JSValue code = JS_GetPropertyStr(ctx, global, "__exitCode");
	int32_t exit_code = 0;
	if (JS_IsNumber(code)) JS_ToInt32(ctx, &exit_code, code);
	// No teardown: the process ends here and a walk of a large heap to free
	// it would only add to the measured time.
	fflush(stdout);
	return failed ? 1 : exit_code;
}
