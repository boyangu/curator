// The spike's host: QuickJS and SQLite in one process, the way a phone app's
// native library would hold them. JavaScript sees one global, `__host`: a
// SQLite binding shaped for the better-sqlite3 shim (shim/better-sqlite3.ts),
// SHA-1 and SHA-256, gzip, files, a plain HTTP request, clocks and memory
// figures (the engine-neutral half is common.h, shared with the Hermes host,
// host-hermes.cpp). No JNI, no threads: a command-line program run under
// `adb shell`, so the numbers are the engine's own.
//
//   host core.js [more.js ...] -- <args for the script>
//
// Value mapping follows better-sqlite3, because the fold must write the same
// bytes the desktop writes:
//   bind   number that is an int32 -> INTEGER, any other number -> REAL,
//          string -> TEXT (a lone surrogate becomes U+FFFD, as V8 writes it),
//          bigint -> INTEGER, typed array -> BLOB, null/undefined -> NULL;
//   read   INTEGER/REAL -> number, TEXT -> string, BLOB -> Buffer, NULL -> null.

#include "common.h"
#include "quickjs.h"
#include "sqlite3.h"

// ── values ───────────────────────────────────────────────────────────────────

static JSClassID db_class, stmt_class, inflate_class;
static JSValue blob_wrap;	// JS: Uint8Array -> Buffer

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

// QuickJS makes InternalError uncatchable by scripts: a host failure is a
// plain Error, so a refused connection can be caught like any other.
static JSValue throw_message(JSContext *ctx, const char *msg) {
	return JS_ThrowPlainError(ctx, "%s", msg);
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
	Hasher h;
	hasher_init(&h, bits);
	for (int64_t i = 0; i < n; i++) {
		JSValue v = JS_GetPropertyUint32(ctx, argv[0], (uint32_t)i);
		if (JS_IsException(v)) return v;
		size_t len = 0;
		if (JS_IsString(v)) {
			char *owned;
			const char *raw = JS_ToCStringLen(ctx, &len, v);
			if (!raw) { JS_FreeValue(ctx, v); return JS_EXCEPTION; }
			hasher_update(&h, (const uint8_t *)utf8_like_v8(raw, len, &owned), len);
			free(owned);
			JS_FreeCString(ctx, raw);
		} else {
			uint8_t *p = bytes_of(ctx, v, &len);
			if (!p) { JS_FreeValue(ctx, v); return JS_EXCEPTION; }
			hasher_update(&h, p, len);
		}
		JS_FreeValue(ctx, v);
	}
	uint8_t out[32];
	size_t size = hasher_final(&h, out);
	if (!JS_ToBool(ctx, argv[1])) return JS_NewUint8ArrayCopy(ctx, out, size);
	char hex[65];
	hex_of(out, size, hex);
	return JS_NewStringLen(ctx, hex, 2 * size);
}

// A running hash (hashOpen / hashUpdate / hashDigest): node:crypto's
// createHash as the core uses it on large inputs — a replica's whole file,
// fed a part at a time, never held whole.
static JSClassID hasher_class;

static void hasher_finalizer(JSRuntime *rt, JSValueConst val) {
	(void)rt;
	free(JS_GetOpaque(val, hasher_class));
}

static JSValue js_hash_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int32_t bits = 160;
	if (JS_ToInt32(ctx, &bits, argv[0])) return JS_EXCEPTION;
	Hasher *h = malloc(sizeof *h);
	hasher_init(h, bits);
	JSValue obj = JS_NewObjectClass(ctx, hasher_class);
	JS_SetOpaque(obj, h);
	return obj;
}

static JSValue js_hash_update(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Hasher *h = JS_GetOpaque2(ctx, argv[0], hasher_class);
	if (!h) return JS_EXCEPTION;
	size_t len = 0;
	if (JS_IsString(argv[1])) {
		char *owned;
		const char *raw = JS_ToCStringLen(ctx, &len, argv[1]);
		if (!raw) return JS_EXCEPTION;
		hasher_update(h, (const uint8_t *)utf8_like_v8(raw, len, &owned), len);
		free(owned);
		JS_FreeCString(ctx, raw);
	} else {
		uint8_t *p = bytes_of(ctx, argv[1], &len);
		if (!p) return JS_EXCEPTION;
		hasher_update(h, p, len);
	}
	return JS_UNDEFINED;
}

static JSValue js_hash_digest(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Hasher *h = JS_GetOpaque2(ctx, argv[0], hasher_class);
	if (!h) return JS_EXCEPTION;
	uint8_t out[32];
	size_t size = hasher_final(h, out);
	if (!JS_ToBool(ctx, argv[1])) return JS_NewUint8ArrayCopy(ctx, out, size);
	char hex[65];
	hex_of(out, size, hex);
	return JS_NewStringLen(ctx, hex, 2 * size);
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
	char err[512];
	size_t len;
	uint8_t *buf = read_file(path, &len, err, sizeof err);
	JS_FreeCString(ctx, path);
	if (!buf) return throw_message(ctx, err);
	JSValue s = JS_NewStringLen(ctx, (const char *)buf, len);
	free(buf);
	return s;
}

// -> ArrayBuffer owning the file's bytes (no second copy).
static JSValue js_read_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	char err[512];
	size_t len;
	uint8_t *buf = read_file(path, &len, err, sizeof err);
	JS_FreeCString(ctx, path);
	if (!buf) return throw_message(ctx, err);
	return JS_NewArrayBuffer(ctx, buf, len, 0, host_buffer, NULL, false);
}

static JSValue js_write_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	size_t len;
	const char *text = JS_ToCStringLen(ctx, &len, argv[1]);
	if (!path || !text) return JS_EXCEPTION;
	char err[512];
	JSValue r = write_file(path, text, len, err, sizeof err) ? JS_UNDEFINED : throw_message(ctx, err);
	JS_FreeCString(ctx, path);
	JS_FreeCString(ctx, text);
	return r;
}

// writeBytes(path, bytes, append): a typed array or ArrayBuffer to a file.
static JSValue js_write_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	size_t len;
	uint8_t *p = bytes_of(ctx, argv[1], &len);
	if (!p) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	char err[512];
	JSValue r = write_file_mode(path, p, len, JS_ToBool(ctx, argv[2]), err, sizeof err) ? JS_UNDEFINED : throw_message(ctx, err);
	JS_FreeCString(ctx, path);
	return r;
}

// fileSize(path) -> bytes, or -1 when nothing is there.
static JSValue js_file_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	long long n = file_size(path);
	JS_FreeCString(ctx, path);
	return JS_NewFloat64(ctx, (double)n);
}

static JSValue js_rename_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *from = JS_ToCString(ctx, argv[0]);
	const char *to = JS_ToCString(ctx, argv[1]);
	char err[1024];
	JSValue r = from && to ? (rename_file(from, to, err, sizeof err) ? JS_UNDEFINED : throw_message(ctx, err)) : JS_EXCEPTION;
	JS_FreeCString(ctx, from);
	JS_FreeCString(ctx, to);
	return r;
}

static JSValue js_remove_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	char err[512];
	JSValue r = remove_file(path, err, sizeof err) ? JS_UNDEFINED : throw_message(ctx, err);
	JS_FreeCString(ctx, path);
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

static void inflate_finalizer(JSRuntime *rt, JSValueConst val) {
	InflateStream *s = JS_GetOpaque(val, inflate_class);
	(void)rt;
	if (s) inflate_close(s);
}

static JSValue js_inflate_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len;
	uint8_t *in = bytes_of(ctx, argv[0], &len);
	if (!in) return JS_EXCEPTION;
	char err[128];
	InflateStream *s = inflate_open(in, len, err, sizeof err);
	if (!s) return throw_message(ctx, err);
	JSValue obj = JS_NewObjectClass(ctx, inflate_class);
	JS_SetOpaque(obj, s);
	return obj;
}

// -> ArrayBuffer of up to `max` inflated bytes, or null once the body is out.
static JSValue js_inflate_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	InflateStream *s = JS_GetOpaque2(ctx, argv[0], inflate_class);
	int32_t max;
	if (!s || JS_ToInt32(ctx, &max, argv[1])) return JS_EXCEPTION;
	char err[128];
	size_t n;
	uint8_t *out = inflate_read(s, (size_t)max, &n, err, sizeof err);
	if (!out) return err[0] ? throw_message(ctx, err) : JS_NULL;
	return JS_NewArrayBuffer(ctx, out, n, 0, host_buffer, NULL, false);
}

// gzip body -> ArrayBuffer of the inflated bytes.
static JSValue js_gunzip(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len;
	uint8_t *in = bytes_of(ctx, argv[0], &len);
	if (!in) return JS_EXCEPTION;
	char err[128];
	size_t n;
	uint8_t *out = gunzip_all(in, len, &n, err, sizeof err);
	if (!out) return throw_message(ctx, err);
	return JS_NewArrayBuffer(ctx, out, n, 0, host_buffer, NULL, false);
}

// http(method, host, port, path, headerLines, body|null) -> { status, body }.
static JSValue js_http(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *method = JS_ToCString(ctx, argv[0]);
	const char *host = JS_ToCString(ctx, argv[1]);
	const char *path = JS_ToCString(ctx, argv[3]);
	const char *lines = JS_ToCString(ctx, argv[4]);
	int32_t port = 80;
	size_t body_len = 0;
	const char *body = JS_IsNull(argv[5]) || JS_IsUndefined(argv[5]) ? NULL : JS_ToCStringLen(ctx, &body_len, argv[5]);
	JSValue out = JS_EXCEPTION;
	if (method && host && path && lines && !JS_ToInt32(ctx, &port, argv[2])) {
		char err[512];
		HttpAnswer a;
		if (!http_request(method, host, port, path, lines, body, body_len, &a, err, sizeof err)) throw_message(ctx, err);
		else {
			out = JS_NewObject(ctx);
			JS_DefinePropertyValueStr(ctx, out, "status", JS_NewInt32(ctx, a.status), JS_PROP_C_W_E);
			JS_DefinePropertyValueStr(ctx, out, "body", JS_NewArrayBufferCopy(ctx, a.body, a.body_len), JS_PROP_C_W_E);
			free(a.buf);
		}
	}
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
	return JS_NewFloat64(ctx, wall_ms());
}

static JSValue js_hrtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	return JS_NewFloat64(ctx, mono_ms());
}

static JSValue js_random_uuid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	char s[37];
	if (!random_uuid(s)) return throw_message(ctx, "no /dev/urandom");
	return JS_NewStringLen(ctx, s, 36);
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
	JS_CFUNC_DEF("hashOpen", 1, js_hash_open),
	JS_CFUNC_DEF("hashUpdate", 2, js_hash_update),
	JS_CFUNC_DEF("hashDigest", 2, js_hash_digest),
	JS_CFUNC_DEF("readText", 1, js_read_text),
	JS_CFUNC_DEF("readBytes", 1, js_read_bytes),
	JS_CFUNC_DEF("writeText", 2, js_write_text),
	JS_CFUNC_DEF("writeBytes", 3, js_write_bytes),
	JS_CFUNC_DEF("fileSize", 1, js_file_size),
	JS_CFUNC_DEF("renameFile", 2, js_rename_file),
	JS_CFUNC_DEF("removeFile", 1, js_remove_file),
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
	JSClassDef hasher_def = { "HostHasher", .finalizer = hasher_finalizer };
	JS_NewClassID(rt, &hasher_class);
	JS_NewClass(rt, hasher_class, &hasher_def);

	int split = 1;
	while (split < argc && strcmp(argv[split], "--") != 0) split++;

	JSValue global = JS_GetGlobalObject(ctx);
	JSValue host = JS_NewObject(ctx);
	JS_SetPropertyFunctionList(ctx, host, host_funcs, sizeof host_funcs / sizeof host_funcs[0]);
	JSValue args = JS_NewArray(ctx);
	for (int i = split + 1; i < argc; i++) JS_SetPropertyUint32(ctx, args, (uint32_t)(i - split - 1), JS_NewString(ctx, argv[i]));
	JS_SetPropertyStr(ctx, host, "args", args);
	char engine[64];
	snprintf(engine, sizeof engine, "quickjs-ng %s", JS_GetVersion());
	JS_SetPropertyStr(ctx, host, "engine", JS_NewString(ctx, engine));
	JS_SetPropertyStr(ctx, host, "sqlite", JS_NewString(ctx, sqlite3_libversion()));
	JS_SetPropertyStr(ctx, global, "__host", host);

	for (int i = 1; i < split && !failed; i++) {
		char err[512];
		size_t len;
		uint8_t *src = read_file(argv[i], &len, err, sizeof err);
		if (!src) { fprintf(stderr, "%s\n", err); failed = 1; break; }
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
