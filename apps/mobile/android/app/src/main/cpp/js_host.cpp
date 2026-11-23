// The sync core's host: Hermes, through JSI, with one global `__host` the
// bundle's shims call (js/shim/host.ts holds its typed surface). From the
// sync-core spike's Hermes host (research/mobile/sync-core-spike/host/
// host-hermes.cpp), which ran the same bundle against the real library: the
// database, hashing, file and gzip functions are its, unchanged in behaviour.
// What is new is the app around it:
//
//   - Kotlin owns the one thread everything here runs on (core/CoreRuntime.kt:
//     a HandlerThread). Every native* entry point is called on it, and the
//     runtime is never touched from another.
//   - HTTP is Kotlin's (TLS, the platform's stack): __host.httpStart hands a
//     request to CoreRuntime.onHttp; the answer comes back through
//     nativeHttpDone, which calls the bundle's __httpDone.
//   - Events go to CoreRuntime.onEmit as JSON; logs go to logcat.
//   - Timers and setImmediate are the bundle's own queue; nativeRun drains
//     promise jobs and runs due tasks for up to a budget, then answers when
//     the next one is due, and Kotlin posts the next run then. Nothing spins,
//     and Kotlin's own messages (a call, an HTTP answer) interleave.
//
// Hermes on Android hands Unicode work to Java through fbjni; the app loads
// libfbjni first (its JNI_OnLoad keeps the VM), so it is ready before this.

#include "native.h"
#include "sqlite3.h"

#include <android/log.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <jni.h>

#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace jsi = facebook::jsi;

namespace {

const char *TAG = "curator-core";

// Property names asked for on every call, made once.
struct Names {
	jsi::PropNameID buffer, byteOffset, byteLength, changes, lastInsertRowid, name, errcode;
};

struct Runtime {
	std::unique_ptr<facebook::hermes::HermesRuntime> rt;
	std::unique_ptr<Names> names;
	std::unique_ptr<jsi::Function> uint8ArrayCtor;
	std::unique_ptr<jsi::Function> blobWrap;	// JS: Uint8Array -> Buffer
	jobject peer = nullptr;	// the CoreRuntime, a global reference
	jmethodID onEmit = nullptr, onHttp = nullptr;
};

// One per process: the app has one core.
Runtime *core;
// The JNIEnv of the native* call in progress (always the JS thread's).
thread_local JNIEnv *callEnv;

const jsi::Value &undefinedValue() {
	static const jsi::Value u;
	return u;
}

[[noreturn]] void throwAs(jsi::Runtime &rt, const char *ctor, const std::string &msg) {
	jsi::Function f = rt.global().getPropertyAsFunction(rt, ctor);
	throw jsi::JSError(rt, f.callAsConstructor(rt, jsi::String::createFromUtf8(rt, msg)));
}

[[noreturn]] void throwSqlite(jsi::Runtime &rt, sqlite3 *db, int rc) {
	jsi::Function f = rt.global().getPropertyAsFunction(rt, "Error");
	jsi::Object e = f.callAsConstructor(rt, jsi::String::createFromUtf8(rt, db ? sqlite3_errmsg(db) : sqlite3_errstr(rc))).getObject(rt);
	e.setProperty(rt, core->names->name, jsi::String::createFromAscii(rt, "SqliteError"));
	e.setProperty(rt, core->names->errcode, db ? sqlite3_extended_errcode(db) : rc);
	throw jsi::JSError(rt, jsi::Value(rt, e));
}

// A buffer Hermes holds without copying: malloc'd bytes, freed with the
// ArrayBuffer.
struct MallocBuffer : jsi::MutableBuffer {
	uint8_t *p;
	size_t n;
	MallocBuffer(uint8_t *p, size_t n) : p(p), n(n) {}
	~MallocBuffer() override { free(p); }
	size_t size() const override { return n; }
	uint8_t *data() override { return p; }
};

jsi::ArrayBuffer ownedBuffer(jsi::Runtime &rt, uint8_t *p, size_t n) {
	return jsi::ArrayBuffer(rt, std::make_shared<MallocBuffer>(p, n));
}

jsi::ArrayBuffer copiedBuffer(jsi::Runtime &rt, const uint8_t *p, size_t n) {
	uint8_t *q = (uint8_t *)malloc(n ? n : 1);
	if (n) memcpy(q, p, n);
	return ownedBuffer(rt, q, n);
}

jsi::Value uint8Copy(jsi::Runtime &rt, const uint8_t *p, size_t n) {
	return core->uint8ArrayCtor->callAsConstructor(rt, copiedBuffer(rt, p, n));
}

// The bytes of a typed array or an ArrayBuffer; null otherwise. The pointer
// lives as long as the value does.
uint8_t *bytesOf(jsi::Runtime &rt, const jsi::Value &v, size_t *len) {
	if (!v.isObject()) return nullptr;
	jsi::Object o = v.getObject(rt);
	if (o.isArrayBuffer(rt)) {
		jsi::ArrayBuffer ab = o.getArrayBuffer(rt);
		*len = ab.size(rt);
		return ab.data(rt);
	}
	jsi::Value buf = o.getProperty(rt, core->names->buffer);
	if (!buf.isObject() || !buf.getObject(rt).isArrayBuffer(rt)) return nullptr;
	jsi::ArrayBuffer ab = buf.getObject(rt).getArrayBuffer(rt);
	size_t off = (size_t)o.getProperty(rt, core->names->byteOffset).asNumber();
	*len = (size_t)o.getProperty(rt, core->names->byteLength).asNumber();
	static uint8_t none;
	return *len == 0 ? &none : ab.data(rt) + off;
}

uint8_t *mustBytes(jsi::Runtime &rt, const jsi::Value &v, size_t *len) {
	uint8_t *p = bytesOf(rt, v, len);
	if (!p) throwAs(rt, "TypeError", "expected a typed array or an ArrayBuffer");
	return p;
}

// A string as the UTF-8 better-sqlite3 writes (a lone surrogate as U+FFFD).
std::string utf8Of(jsi::Runtime &rt, const jsi::Value &v) {
	std::string s = v.asString(rt).utf8(rt);
	utf8_like_v8(s);
	return s;
}

// ── SQLite ───────────────────────────────────────────────────────────────────

struct Stmt;

// A connection and the statements made on it. better-sqlite3's close: every
// statement is finalized, so the file is really closed (and the WAL
// checkpointed) when it returns.
struct DbState {
	sqlite3 *db = nullptr;
	std::set<Stmt *> stmts;
	void release();
	~DbState() { release(); }
};

struct Stmt : jsi::NativeState {
	sqlite3_stmt *st = nullptr;
	std::shared_ptr<DbState> owner;
	std::vector<jsi::PropNameID> cols;
	void release() {
		if (st) { sqlite3_finalize(st); st = nullptr; }
		if (owner) { owner->stmts.erase(this); owner.reset(); }
	}
	~Stmt() override { release(); }
};

void DbState::release() {
	while (!stmts.empty()) {
		Stmt *s = *stmts.begin();
		stmts.erase(stmts.begin());
		if (s->st) { sqlite3_finalize(s->st); s->st = nullptr; }
		s->owner.reset();
	}
	if (db) { sqlite3_close(db); db = nullptr; }
}

struct Db : jsi::NativeState {
	std::shared_ptr<DbState> state = std::make_shared<DbState>();
	~Db() override { state->release(); }
};

// The native state of the kind asked for, or null. JSI's getNativeState<T>
// only checks the kind in a debug build.
template <typename T>
std::shared_ptr<T> stateOf(jsi::Runtime &rt, const jsi::Value &v) {
	if (!v.isObject()) return nullptr;
	jsi::Object o = v.getObject(rt);
	if (!o.hasNativeState(rt)) return nullptr;
	return std::dynamic_pointer_cast<T>(o.getNativeState(rt));
}

std::shared_ptr<Db> dbOf(jsi::Runtime &rt, const jsi::Value &v, bool open = true) {
	std::shared_ptr<Db> d = stateOf<Db>(rt, v);
	if (!d) throwAs(rt, "TypeError", "not a database");
	if (open && !d->state->db) throwAs(rt, "TypeError", "The database connection is not open");
	return d;
}

std::shared_ptr<Stmt> stmtOf(jsi::Runtime &rt, const jsi::Value &v, bool open = true) {
	std::shared_ptr<Stmt> s = stateOf<Stmt>(rt, v);
	if (!s) throwAs(rt, "TypeError", "not a statement");
	if (open && !s->st) throwAs(rt, "TypeError", "The database connection is not open");
	return s;
}

void bindAll(jsi::Runtime &rt, Stmt &s, const jsi::Value &params) {
	sqlite3_stmt *st = s.st;
	int want = sqlite3_bind_parameter_count(st);
	size_t have = 0;
	std::optional<jsi::Array> list;
	if (!params.isUndefined() && !params.isNull()) {
		list.emplace(params.asObject(rt).asArray(rt));
		have = list->size(rt);
	}
	if ((int)have != want) throwAs(rt, "RangeError", (int)have < want ? "Too few parameter values were provided" : "Too many parameter values were provided");
	for (int i = 0; i < want; i++) {
		jsi::Value v = list->getValueAtIndex(rt, (size_t)i);
		int rc;
		if (v.isNumber()) {
			double d = v.getNumber();
			if (d >= -2147483648.0 && d <= 2147483647.0 && d == floor(d) && !(d == 0 && signbit(d))) rc = sqlite3_bind_int(st, i + 1, (int)d);
			else rc = sqlite3_bind_double(st, i + 1, d);
		} else if (v.isString()) {
			std::string t = utf8Of(rt, v);
			rc = sqlite3_bind_text(st, i + 1, t.data(), (int)t.size(), SQLITE_TRANSIENT);
		} else if (v.isNull() || v.isUndefined()) {
			rc = sqlite3_bind_null(st, i + 1);
		} else if (v.isBigInt()) {
			rc = sqlite3_bind_int64(st, i + 1, v.getBigInt(rt).getInt64(rt));
		} else if (v.isBool()) {
			rc = sqlite3_bind_int(st, i + 1, v.getBool() ? 1 : 0);
		} else {
			size_t len = 0;
			uint8_t *p = bytesOf(rt, v, &len);
			if (!p) throwAs(rt, "TypeError", "SQLite3 can only bind numbers, strings, bigints, buffers, and null");
			rc = sqlite3_bind_blob(st, i + 1, p, (int)len, SQLITE_TRANSIENT);
		}
		if (rc != SQLITE_OK) throwSqlite(rt, sqlite3_db_handle(st), rc);
	}
}

jsi::Value colValue(jsi::Runtime &rt, sqlite3_stmt *st, int i) {
	switch (sqlite3_column_type(st, i)) {
		case SQLITE_INTEGER: return jsi::Value((double)sqlite3_column_int64(st, i));
		case SQLITE_FLOAT: return jsi::Value(sqlite3_column_double(st, i));
		case SQLITE_TEXT: return jsi::String::createFromUtf8(rt, sqlite3_column_text(st, i), (size_t)sqlite3_column_bytes(st, i));
		case SQLITE_BLOB: {
			jsi::Value u = uint8Copy(rt, (const uint8_t *)sqlite3_column_blob(st, i), (size_t)sqlite3_column_bytes(st, i));
			return core->blobWrap ? core->blobWrap->call(rt, u) : std::move(u);
		}
		default: return jsi::Value::null();
	}
}

// mode 0: an object keyed by column; 1: the first column alone (pluck); 2: an array (raw).
jsi::Value readRow(jsi::Runtime &rt, Stmt &s, int mode) {
	if (mode == 1) return colValue(rt, s.st, 0);
	int n = (int)s.cols.size();
	if (mode == 2) {
		jsi::Array row(rt, (size_t)n);
		for (int i = 0; i < n; i++) row.setValueAtIndex(rt, (size_t)i, colValue(rt, s.st, i));
		return row;
	}
	jsi::Object row(rt);
	for (int i = 0; i < n; i++) row.setProperty(rt, s.cols[(size_t)i], colValue(rt, s.st, i));
	return row;
}

// ── the host's functions ─────────────────────────────────────────────────────

using Args = const jsi::Value *;
#define A(i) ((i) < count ? args[i] : undefinedValue())
#define HOST_FN(name) jsi::Value name(jsi::Runtime &rt, const jsi::Value &, Args args, size_t count)

HOST_FN(dbOpen) {
	std::string path = A(0).asString(rt).utf8(rt);
	bool readonly = A(1).isBool() && A(1).getBool(), mustExist = A(2).isBool() && A(2).getBool();
	int flags = (readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | (mustExist ? 0 : SQLITE_OPEN_CREATE)) | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_URI;
	sqlite3 *db = nullptr;
	int rc = sqlite3_open_v2(path.c_str(), &db, flags, nullptr);
	if (rc != SQLITE_OK) {
		std::string msg = db ? sqlite3_errmsg(db) : sqlite3_errstr(rc);
		int code = db ? sqlite3_extended_errcode(db) : rc;
		sqlite3_close(db);
		jsi::Function f = rt.global().getPropertyAsFunction(rt, "Error");
		jsi::Object e = f.callAsConstructor(rt, jsi::String::createFromUtf8(rt, msg)).getObject(rt);
		e.setProperty(rt, core->names->name, jsi::String::createFromAscii(rt, "SqliteError"));
		e.setProperty(rt, core->names->errcode, code);
		throw jsi::JSError(rt, jsi::Value(rt, e));
	}
	sqlite3_extended_result_codes(db, 1);
	// The views read the same file from Kotlin (db_jni.cpp): a write waits for
	// a read in flight instead of failing.
	sqlite3_busy_timeout(db, 5000);
	auto d = std::make_shared<Db>();
	d->state->db = db;
	jsi::Object obj(rt);
	obj.setNativeState(rt, d);
	return obj;
}

HOST_FN(dbClose) {
	dbOf(rt, A(0), false)->state->release();
	return jsi::Value::undefined();
}

HOST_FN(dbExec) {
	auto d = dbOf(rt, A(0));
	std::string sql = A(1).asString(rt).utf8(rt);
	int rc = sqlite3_exec(d->state->db, sql.c_str(), nullptr, nullptr, nullptr);
	if (rc != SQLITE_OK) throwSqlite(rt, d->state->db, rc);
	return jsi::Value::undefined();
}

HOST_FN(dbAutocommit) {
	return jsi::Value(sqlite3_get_autocommit(dbOf(rt, A(0))->state->db) != 0);
}

// -> [statement, returnsRows, parameterNames]; a name is null for a plain `?`.
HOST_FN(dbPrepare) {
	auto d = dbOf(rt, A(0));
	std::string sql = A(1).asString(rt).utf8(rt);
	sqlite3_stmt *st = nullptr;
	const char *tail = nullptr;
	int rc = sqlite3_prepare_v2(d->state->db, sql.c_str(), (int)sql.size() + 1, &st, &tail);
	if (rc != SQLITE_OK) throwSqlite(rt, d->state->db, rc);
	if (!st) throwAs(rt, "RangeError", "The supplied SQL string contains no statements");
	if (tail && has_more_sql(tail)) { sqlite3_finalize(st); throwAs(rt, "RangeError", "The supplied SQL string contains more than one statement"); }

	auto s = std::make_shared<Stmt>();
	s->st = st;
	s->owner = d->state;
	d->state->stmts.insert(s.get());
	int ncol = sqlite3_column_count(st);
	for (int i = 0; i < ncol; i++) s->cols.push_back(jsi::PropNameID::forUtf8(rt, sqlite3_column_name(st, i)));
	jsi::Object obj(rt);
	obj.setNativeState(rt, s);

	int np = sqlite3_bind_parameter_count(st);
	jsi::Array params(rt, (size_t)np);
	for (int i = 0; i < np; i++) {
		const char *n = sqlite3_bind_parameter_name(st, i + 1);
		params.setValueAtIndex(rt, (size_t)i, n ? jsi::Value(jsi::String::createFromUtf8(rt, n)) : jsi::Value::null());
	}
	jsi::Array out(rt, 3);
	out.setValueAtIndex(rt, 0, obj);
	out.setValueAtIndex(rt, 1, jsi::Value(ncol > 0));
	out.setValueAtIndex(rt, 2, params);
	return out;
}

HOST_FN(stmtRun) {
	auto s = stmtOf(rt, A(0));
	bindAll(rt, *s, A(1));
	sqlite3 *db = sqlite3_db_handle(s->st);
	int before = sqlite3_total_changes(db);
	while (sqlite3_step(s->st) == SQLITE_ROW) {}
	int rc = sqlite3_reset(s->st);
	if (rc != SQLITE_OK) throwSqlite(rt, db, rc);
	jsi::Object info(rt);
	info.setProperty(rt, core->names->changes, sqlite3_total_changes(db) == before ? 0 : sqlite3_changes(db));
	info.setProperty(rt, core->names->lastInsertRowid, (double)sqlite3_last_insert_rowid(db));
	return info;
}

HOST_FN(stmtGet) {
	auto s = stmtOf(rt, A(0));
	bindAll(rt, *s, A(1));
	int mode = (int)A(2).asNumber();
	sqlite3 *db = sqlite3_db_handle(s->st);
	jsi::Value row;
	if (sqlite3_step(s->st) == SQLITE_ROW) {
		try { row = readRow(rt, *s, mode); } catch (...) { sqlite3_reset(s->st); throw; }
	}
	int rc = sqlite3_reset(s->st);
	if (rc != SQLITE_OK) throwSqlite(rt, db, rc);
	return row;
}

HOST_FN(stmtAll) {
	auto s = stmtOf(rt, A(0));
	bindAll(rt, *s, A(1));
	int mode = (int)A(2).asNumber();
	sqlite3 *db = sqlite3_db_handle(s->st);
	std::vector<jsi::Value> rows;
	try {
		while (sqlite3_step(s->st) == SQLITE_ROW) rows.push_back(readRow(rt, *s, mode));
	} catch (...) { sqlite3_reset(s->st); throw; }
	int rc = sqlite3_reset(s->st);
	if (rc != SQLITE_OK) throwSqlite(rt, db, rc);
	jsi::Array out(rt, rows.size());
	for (size_t i = 0; i < rows.size(); i++) out.setValueAtIndex(rt, i, std::move(rows[i]));
	return out;
}

// iterate(): bind, then one row a call; `undefined` once the rows are out.
HOST_FN(stmtIterStart) {
	auto s = stmtOf(rt, A(0));
	bindAll(rt, *s, A(1));
	return jsi::Value::undefined();
}

HOST_FN(stmtIterNext) {
	auto s = stmtOf(rt, A(0));
	int mode = (int)A(1).asNumber();
	if (sqlite3_step(s->st) == SQLITE_ROW) return readRow(rt, *s, mode);
	int rc = sqlite3_reset(s->st);
	if (rc != SQLITE_OK) throwSqlite(rt, sqlite3_db_handle(s->st), rc);
	return jsi::Value::undefined();
}

HOST_FN(stmtReset) {
	auto s = stmtOf(rt, A(0), false);
	if (s->st) sqlite3_reset(s->st);
	return jsi::Value::undefined();
}

// hash(parts, hex, bits): SHA-1 (bits 160) or SHA-256 (256) of the parts in
// order; a part is a string (hashed as UTF-8) or a typed array.
HOST_FN(hash) {
	jsi::Array parts = A(0).asObject(rt).asArray(rt);
	Hasher h;
	hasher_init(&h, A(2).isNumber() ? (int)A(2).getNumber() : 160);
	size_t n = parts.size(rt);
	for (size_t i = 0; i < n; i++) {
		jsi::Value v = parts.getValueAtIndex(rt, i);
		if (v.isString()) {
			std::string t = utf8Of(rt, v);
			hasher_update(&h, (const uint8_t *)t.data(), t.size());
		} else {
			size_t len = 0;
			uint8_t *p = mustBytes(rt, v, &len);
			hasher_update(&h, p, len);
		}
	}
	uint8_t out[32];
	size_t size = hasher_final(&h, out);
	if (!(A(1).isBool() && A(1).getBool())) return uint8Copy(rt, out, size);
	char hex[65];
	hex_of(out, size, hex);
	return jsi::String::createFromAscii(rt, hex, 2 * size);
}

// A running hash: node:crypto's createHash on large inputs — a replica's
// whole file, fed a part at a time, never held whole.
struct RunningHash : jsi::NativeState {
	Hasher h;
};

HOST_FN(hashOpen) {
	auto s = std::make_shared<RunningHash>();
	hasher_init(&s->h, A(0).isNumber() ? (int)A(0).getNumber() : 160);
	jsi::Object obj(rt);
	obj.setNativeState(rt, s);
	return obj;
}

HOST_FN(hashUpdate) {
	std::shared_ptr<RunningHash> s = stateOf<RunningHash>(rt, A(0));
	if (!s) throwAs(rt, "TypeError", "not a running hash");
	if (A(1).isString()) {
		std::string t = utf8Of(rt, A(1));
		hasher_update(&s->h, (const uint8_t *)t.data(), t.size());
	} else {
		size_t len = 0;
		uint8_t *p = mustBytes(rt, A(1), &len);
		hasher_update(&s->h, p, len);
	}
	return jsi::Value::undefined();
}

HOST_FN(hashDigest) {
	std::shared_ptr<RunningHash> s = stateOf<RunningHash>(rt, A(0));
	if (!s) throwAs(rt, "TypeError", "not a running hash");
	uint8_t out[32];
	size_t size = hasher_final(&s->h, out);
	if (!(A(1).isBool() && A(1).getBool())) return uint8Copy(rt, out, size);
	char hex[65];
	hex_of(out, size, hex);
	return jsi::String::createFromAscii(rt, hex, 2 * size);
}

HOST_FN(readText) {
	std::string path = A(0).asString(rt).utf8(rt), err;
	size_t len;
	uint8_t *buf = read_file(path.c_str(), &len, err);
	if (!buf) throwAs(rt, "Error", err);
	jsi::Value s = jsi::String::createFromUtf8(rt, buf, len);
	free(buf);
	return s;
}

// -> ArrayBuffer owning the file's bytes (no second copy).
HOST_FN(readBytes) {
	std::string path = A(0).asString(rt).utf8(rt), err;
	size_t len;
	uint8_t *buf = read_file(path.c_str(), &len, err);
	if (!buf) throwAs(rt, "Error", err);
	return ownedBuffer(rt, buf, len);
}

HOST_FN(writeText) {
	std::string path = A(0).asString(rt).utf8(rt), text = A(1).asString(rt).utf8(rt), err;
	if (!write_file_mode(path.c_str(), text.data(), text.size(), false, err)) throwAs(rt, "Error", err);
	return jsi::Value::undefined();
}

// writeBytes(path, bytes, append): a typed array or ArrayBuffer to a file.
HOST_FN(writeBytes) {
	std::string path = A(0).asString(rt).utf8(rt), err;
	size_t len;
	uint8_t *p = mustBytes(rt, A(1), &len);
	if (!write_file_mode(path.c_str(), p, len, A(2).isBool() && A(2).getBool(), err)) throwAs(rt, "Error", err);
	return jsi::Value::undefined();
}

HOST_FN(fileSize) {
	return jsi::Value((double)file_size(A(0).asString(rt).utf8(rt).c_str()));
}

HOST_FN(renameFile) {
	std::string from = A(0).asString(rt).utf8(rt), to = A(1).asString(rt).utf8(rt);
	if (rename(from.c_str(), to.c_str()) != 0) throwAs(rt, "Error", "cannot rename " + from + " to " + to + ": " + strerror(errno));
	return jsi::Value::undefined();
}

// Gone already is fine.
HOST_FN(removeFile) {
	std::string path = A(0).asString(rt).utf8(rt);
	if (remove(path.c_str()) != 0 && errno != ENOENT) throwAs(rt, "Error", "cannot remove " + path + ": " + strerror(errno));
	return jsi::Value::undefined();
}

HOST_FN(makeDirs) {
	std::string path = A(0).asString(rt).utf8(rt), err;
	if (!make_dirs(path, err)) throwAs(rt, "Error", err);
	return jsi::Value::undefined();
}

HOST_FN(utf8Decode) {
	size_t len;
	uint8_t *p = mustBytes(rt, A(0), &len);
	return jsi::String::createFromUtf8(rt, p, len);
}

HOST_FN(utf8Encode) {
	std::string t = utf8Of(rt, A(0));
	return uint8Copy(rt, (const uint8_t *)t.data(), t.size());
}

struct Inflate : jsi::NativeState {
	InflateStream *s;
	explicit Inflate(InflateStream *s) : s(s) {}
	~Inflate() override { inflate_close(s); }
};

HOST_FN(inflateOpen) {
	size_t len;
	uint8_t *in = mustBytes(rt, A(0), &len);
	InflateStream *s = inflate_open(in, len);
	if (!s) throwAs(rt, "Error", "inflateInit2 failed");
	jsi::Object obj(rt);
	obj.setNativeState(rt, std::make_shared<Inflate>(s));
	return obj;
}

// -> ArrayBuffer of up to `max` inflated bytes, or null once the body is out.
HOST_FN(inflateRead) {
	std::shared_ptr<Inflate> h = stateOf<Inflate>(rt, A(0));
	if (!h) throwAs(rt, "TypeError", "not an inflate stream");
	std::string err;
	size_t n;
	uint8_t *out = inflate_read(h->s, (size_t)A(1).asNumber(), &n, err);
	if (!out) {
		if (!err.empty()) throwAs(rt, "Error", err);
		return jsi::Value::null();
	}
	return ownedBuffer(rt, out, n);
}

// gzip body -> ArrayBuffer of the inflated bytes.
HOST_FN(gunzip) {
	size_t len;
	uint8_t *in = mustBytes(rt, A(0), &len);
	std::string err;
	size_t n;
	uint8_t *out = gunzip_all(in, len, &n, err);
	if (!out) throwAs(rt, "Error", err);
	return ownedBuffer(rt, out, n);
}

jstring jstringOf(JNIEnv *env, const std::string &s) {
	std::u16string u = utf16_of(s.data(), s.size());
	return env->NewString((const jchar *)u.data(), (jsize)u.size());
}

// httpStart(id, method, url, headersJson, body|null): Kotlin sends it.
HOST_FN(httpStart) {
	JNIEnv *env = callEnv;
	int id = (int)A(0).asNumber();
	std::string method = A(1).asString(rt).utf8(rt), url = A(2).asString(rt).utf8(rt), headers = A(3).asString(rt).utf8(rt);
	jbyteArray body = nullptr;
	if (A(4).isString()) {
		std::string b = utf8Of(rt, A(4));
		body = env->NewByteArray((jsize)b.size());
		env->SetByteArrayRegion(body, 0, (jsize)b.size(), (const jbyte *)b.data());
	} else if (A(4).isObject()) {
		size_t len = 0;
		uint8_t *p = mustBytes(rt, A(4), &len);
		body = env->NewByteArray((jsize)len);
		env->SetByteArrayRegion(body, 0, (jsize)len, (const jbyte *)p);
	}
	jstring jm = jstringOf(env, method), ju = jstringOf(env, url), jh = jstringOf(env, headers);
	env->CallVoidMethod(core->peer, core->onHttp, (jint)id, jm, ju, jh, body);
	env->DeleteLocalRef(jm);
	env->DeleteLocalRef(ju);
	env->DeleteLocalRef(jh);
	if (body) env->DeleteLocalRef(body);
	if (env->ExceptionCheck()) { env->ExceptionDescribe(); env->ExceptionClear(); throwAs(rt, "Error", "the app could not start the request"); }
	return jsi::Value::undefined();
}

HOST_FN(emit) {
	JNIEnv *env = callEnv;
	jstring j = jstringOf(env, A(0).asString(rt).utf8(rt));
	env->CallVoidMethod(core->peer, core->onEmit, j);
	env->DeleteLocalRef(j);
	if (env->ExceptionCheck()) { env->ExceptionDescribe(); env->ExceptionClear(); }
	return jsi::Value::undefined();
}

HOST_FN(logLine) {
	int level = A(0).isNumber() ? (int)A(0).getNumber() : ANDROID_LOG_INFO;
	std::string line = A(1).asString(rt).utf8(rt);
	__android_log_write(level, TAG, line.c_str());
	return jsi::Value::undefined();
}

HOST_FN(now) { return jsi::Value(wall_ms()); }
HOST_FN(hrtime) { return jsi::Value(mono_ms()); }

HOST_FN(randomUUID) {
	char s[37];
	if (!random_uuid(s)) throwAs(rt, "Error", "no /dev/urandom");
	return jsi::String::createFromAscii(rt, s, 36);
}

HOST_FN(setBlobWrap) {
	core->blobWrap = std::make_unique<jsi::Function>(A(0).asObject(rt).asFunction(rt));
	return jsi::Value::undefined();
}

#undef A
#undef HOST_FN

struct BytesBuffer : jsi::Buffer {
	std::vector<uint8_t> bytes;
	explicit BytesBuffer(std::vector<uint8_t> b) : bytes(std::move(b)) {}
	size_t size() const override { return bytes.size(); }
	const uint8_t *data() const override { return bytes.data(); }
};

void logError(const char *where, const std::string &what) {
	__android_log_print(ANDROID_LOG_ERROR, TAG, "%s: %s", where, what.c_str());
}

// Runs `fn` on the runtime and the promise jobs it queued; an uncaught error
// is logged (the bundle answers its own call errors through emit).
template <typename F>
void guarded(const char *where, F fn) {
	try {
		fn(*core->rt);
		core->rt->drainMicrotasks();
	} catch (const jsi::JSError &e) {
		logError(where, e.getMessage() + "\n" + e.getStack());
	} catch (const std::exception &e) {
		logError(where, e.what());
	}
}

std::string stringOf(JNIEnv *env, jstring s) {
	if (!s) return {};
	const jchar *c = env->GetStringChars(s, nullptr);
	std::string out = utf8_of((const char16_t *)c, (size_t)env->GetStringLength(s));
	env->ReleaseStringChars(s, c);
	return out;
}

} // namespace

extern "C" {

// CoreRuntime.nativeCreate(bytecode): makes the runtime and evaluates the
// bundle. False (and a logged reason) when the bundle does not load.
JNIEXPORT jboolean JNICALL Java_app_curator_mobile_core_CoreRuntime_nativeCreate(JNIEnv *env, jobject self, jbyteArray bytecode) {
	callEnv = env;
	if (core) return JNI_TRUE;
	core = new Runtime();
	core->peer = env->NewGlobalRef(self);
	jclass cls = env->GetObjectClass(self);
	core->onEmit = env->GetMethodID(cls, "onEmit", "(Ljava/lang/String;)V");
	core->onHttp = env->GetMethodID(cls, "onHttp", "(ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;[B)V");
	env->DeleteLocalRef(cls);

	auto config = hermes::vm::RuntimeConfig::Builder()
		// Promise jobs wait for nativeRun's drain, as Node's wait for the turn.
		.withMicrotaskQueue(true)
		// The bundle's bytecode is compiled with the same (scripts/bundle.mjs).
		.withES6BlockScoping(true)
		.build();
	core->rt = facebook::hermes::makeHermesRuntime(config);
	jsi::Runtime &rt = *core->rt;
	core->names = std::make_unique<Names>(Names{
		jsi::PropNameID::forAscii(rt, "buffer"), jsi::PropNameID::forAscii(rt, "byteOffset"), jsi::PropNameID::forAscii(rt, "byteLength"),
		jsi::PropNameID::forAscii(rt, "changes"), jsi::PropNameID::forAscii(rt, "lastInsertRowid"), jsi::PropNameID::forAscii(rt, "name"),
		jsi::PropNameID::forAscii(rt, "errcode"),
	});
	core->uint8ArrayCtor = std::make_unique<jsi::Function>(rt.global().getPropertyAsFunction(rt, "Uint8Array"));

	jsi::Object host(rt);
	struct Fn { const char *name; unsigned params; jsi::HostFunctionType fn; };
	const Fn fns[] = {
		{ "dbOpen", 3, dbOpen }, { "dbClose", 1, dbClose }, { "dbExec", 2, dbExec }, { "dbAutocommit", 1, dbAutocommit },
		{ "dbPrepare", 2, dbPrepare }, { "stmtRun", 2, stmtRun }, { "stmtGet", 3, stmtGet }, { "stmtAll", 3, stmtAll },
		{ "stmtIterStart", 2, stmtIterStart }, { "stmtIterNext", 2, stmtIterNext }, { "stmtReset", 1, stmtReset },
		{ "hash", 3, hash }, { "hashOpen", 1, hashOpen }, { "hashUpdate", 2, hashUpdate }, { "hashDigest", 2, hashDigest },
		{ "readText", 1, readText }, { "readBytes", 1, readBytes }, { "writeText", 2, writeText }, { "writeBytes", 3, writeBytes },
		{ "fileSize", 1, fileSize }, { "renameFile", 2, renameFile }, { "removeFile", 1, removeFile }, { "makeDirs", 1, makeDirs },
		{ "utf8Decode", 1, utf8Decode }, { "utf8Encode", 1, utf8Encode }, { "gunzip", 1, gunzip },
		{ "inflateOpen", 1, inflateOpen }, { "inflateRead", 2, inflateRead }, { "httpStart", 5, httpStart }, { "emit", 1, emit },
		{ "log", 2, logLine }, { "now", 0, now }, { "hrtime", 0, hrtime }, { "randomUUID", 0, randomUUID }, { "setBlobWrap", 1, setBlobWrap },
	};
	for (const Fn &f : fns) host.setProperty(rt, f.name, jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, f.name), f.params, f.fn));
	host.setProperty(rt, "engine", jsi::String::createFromAscii(rt, "hermes"));
	host.setProperty(rt, "sqlite", jsi::String::createFromAscii(rt, sqlite3_libversion()));
	rt.global().setProperty(rt, "__host", host);

	jsize n = env->GetArrayLength(bytecode);
	std::vector<uint8_t> bytes((size_t)n);
	env->GetByteArrayRegion(bytecode, 0, n, (jbyte *)bytes.data());
	bool ok = true;
	try {
		rt.evaluateJavaScript(std::make_shared<BytesBuffer>(std::move(bytes)), "core.hbc");
		rt.drainMicrotasks();
	} catch (const jsi::JSError &e) {
		logError("loading the core", e.getMessage() + "\n" + e.getStack());
		ok = false;
	} catch (const std::exception &e) {
		logError("loading the core", e.what());
		ok = false;
	}
	return ok ? JNI_TRUE : JNI_FALSE;
}

// A call into the core: __dispatch(name, argJson, id). Its answer is an emit.
JNIEXPORT void JNICALL Java_app_curator_mobile_core_CoreRuntime_nativeDispatch(JNIEnv *env, jobject, jstring name, jstring argJson, jint id) {
	callEnv = env;
	std::string n = stringOf(env, name), a = stringOf(env, argJson);
	guarded("dispatch", [&](jsi::Runtime &rt) {
		rt.global().getPropertyAsFunction(rt, "__dispatch").call(rt, jsi::String::createFromUtf8(rt, n), jsi::String::createFromUtf8(rt, a), (double)id);
	});
}

// Kotlin's answer to an httpStart: the body, or why there is none.
JNIEXPORT void JNICALL Java_app_curator_mobile_core_CoreRuntime_nativeHttpDone(JNIEnv *env, jobject, jint id, jint status, jbyteArray body, jstring error) {
	callEnv = env;
	std::vector<uint8_t> bytes;
	if (body) {
		jsize n = env->GetArrayLength(body);
		bytes.resize((size_t)n);
		env->GetByteArrayRegion(body, 0, n, (jbyte *)bytes.data());
	}
	std::optional<std::string> err;
	if (error) err = stringOf(env, error);
	guarded("http answer", [&](jsi::Runtime &rt) {
		jsi::Value b = body ? jsi::Value(copiedBuffer(rt, bytes.data(), bytes.size())) : jsi::Value::null();
		jsi::Value e = err ? jsi::Value(jsi::String::createFromUtf8(rt, *err)) : jsi::Value::null();
		rt.global().getPropertyAsFunction(rt, "__httpDone").call(rt, (double)id, (double)status, b, e);
	});
}

// Runs due tasks, promise jobs between each, for up to `budgetMs`. -> 0 when
// more are due now, the ms until the next timer, or -1 when nothing is queued.
JNIEXPORT jint JNICALL Java_app_curator_mobile_core_CoreRuntime_nativeRun(JNIEnv *env, jobject, jint budgetMs) {
	callEnv = env;
	double until = mono_ms() + budgetMs;
	int next = -1;
	for (;;) {
		// A task that throws is logged and gone (the queue removes it before
		// running it): the loop goes on to the next.
		next = 0;
		guarded("tick", [&](jsi::Runtime &rt) {
			next = (int)rt.global().getPropertyAsFunction(rt, "__tick").call(rt).asNumber();
		});
		if (next != 0 || mono_ms() >= until) break;
	}
	return next;
}

} // extern "C"
