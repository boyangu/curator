// The spike's host on Hermes: the same program as host.c, over Meta's engine
// through JSI instead of QuickJS's C API. JavaScript sees the same one
// global, `__host`, with the same functions and the same value mapping
// (host.c's header), so one bundle of the sync core runs on either.
//
// A library (libspikehost.so), run inside Android's Java runtime by
// host/java/spike/Main.java with the program's arguments:
//
//   core.hbc [more ...] -- <args for the script>
//
// Hermes on Android needs that runtime: it hands Unicode work (normalize,
// localeCompare, case conversion beyond ASCII) to Java and attaches its
// finalizer thread to the VM, through fbjni.
//
// Each file is Hermes bytecode (scripts/bundle.mjs compiles the bundle with
// hermesc) or plain source. Hermes comes prebuilt (libhermesvm.so from the
// hermes-android AAR); libjsi.so is built from the matching source tag
// (scripts/build-host.mjs).

#include "common.h"
#include "sqlite3.h"

#include <hermes/hermes.h>
#include <jsi/instrumentation.h>
#include <jsi/jsi.h>

#include <functional>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <jni.h>

namespace jsi = facebook::jsi;

namespace {

// Property names asked for on every call, made once.
struct Names {
	jsi::PropNameID buffer, byteOffset, byteLength, status, body, changes, lastInsertRowid, name, errcode, rssKb, peakRssKb, jsHeapKb;
};
Names *names;
jsi::Function *uint8ArrayCtor;
jsi::Function *blobWrap;	// JS: Uint8Array -> Buffer

const jsi::Value &undefinedValue() {
	static const jsi::Value u;
	return u;
}

// An error of one of the language's own kinds (TypeError, RangeError) or a
// plain Error.
[[noreturn]] void throwAs(jsi::Runtime &rt, const char *ctor, const std::string &msg) {
	jsi::Function f = rt.global().getPropertyAsFunction(rt, ctor);
	throw jsi::JSError(rt, f.callAsConstructor(rt, jsi::String::createFromUtf8(rt, msg)));
}

[[noreturn]] void throwSqlite(jsi::Runtime &rt, sqlite3 *db, int rc) {
	jsi::Function f = rt.global().getPropertyAsFunction(rt, "Error");
	jsi::Object e = f.callAsConstructor(rt, jsi::String::createFromUtf8(rt, db ? sqlite3_errmsg(db) : sqlite3_errstr(rc))).getObject(rt);
	e.setProperty(rt, names->name, jsi::String::createFromAscii(rt, "SqliteError"));
	e.setProperty(rt, names->errcode, db ? sqlite3_extended_errcode(db) : rc);
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
	return uint8ArrayCtor->callAsConstructor(rt, copiedBuffer(rt, p, n));
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
	jsi::Value buf = o.getProperty(rt, names->buffer);
	if (!buf.isObject() || !buf.getObject(rt).isArrayBuffer(rt)) return nullptr;
	jsi::ArrayBuffer ab = buf.getObject(rt).getArrayBuffer(rt);
	size_t off = (size_t)o.getProperty(rt, names->byteOffset).asNumber();
	*len = (size_t)o.getProperty(rt, names->byteLength).asNumber();
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
	char *owned;
	utf8_like_v8(s.data(), s.size(), &owned);
	if (owned) { s.assign(owned, s.size()); free(owned); }
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
			// The low 64 bits, as QuickJS's JS_ToBigInt64 takes them.
			rc = sqlite3_bind_int64(st, i + 1, v.getBigInt(rt).getInt64(rt));
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
			return blobWrap ? blobWrap->call(rt, u) : std::move(u);
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
		e.setProperty(rt, names->name, jsi::String::createFromAscii(rt, "SqliteError"));
		e.setProperty(rt, names->errcode, code);
		throw jsi::JSError(rt, jsi::Value(rt, e));
	}
	sqlite3_extended_result_codes(db, 1);
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
	info.setProperty(rt, names->changes, sqlite3_total_changes(db) == before ? 0 : sqlite3_changes(db));
	info.setProperty(rt, names->lastInsertRowid, (double)sqlite3_last_insert_rowid(db));
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

// A running hash (hashOpen / hashUpdate / hashDigest), as host.c's.
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
	std::string path = A(0).asString(rt).utf8(rt);
	char err[512];
	size_t len;
	uint8_t *buf = read_file(path.c_str(), &len, err, sizeof err);
	if (!buf) throwAs(rt, "Error", err);
	jsi::Value s = jsi::String::createFromUtf8(rt, buf, len);
	free(buf);
	return s;
}

// -> ArrayBuffer owning the file's bytes (no second copy).
HOST_FN(readBytes) {
	std::string path = A(0).asString(rt).utf8(rt);
	char err[512];
	size_t len;
	uint8_t *buf = read_file(path.c_str(), &len, err, sizeof err);
	if (!buf) throwAs(rt, "Error", err);
	return ownedBuffer(rt, buf, len);
}

HOST_FN(writeText) {
	std::string path = A(0).asString(rt).utf8(rt);
	std::string text = A(1).asString(rt).utf8(rt);
	char err[512];
	if (!write_file(path.c_str(), text.data(), text.size(), err, sizeof err)) throwAs(rt, "Error", err);
	return jsi::Value::undefined();
}

// writeBytes(path, bytes, append): a typed array or ArrayBuffer to a file.
HOST_FN(writeBytes) {
	std::string path = A(0).asString(rt).utf8(rt);
	size_t len;
	uint8_t *p = mustBytes(rt, A(1), &len);
	char err[512];
	if (!write_file_mode(path.c_str(), p, len, A(2).isBool() && A(2).getBool(), err, sizeof err)) throwAs(rt, "Error", err);
	return jsi::Value::undefined();
}

HOST_FN(fileSize) {
	return jsi::Value((double)file_size(A(0).asString(rt).utf8(rt).c_str()));
}

HOST_FN(renameFile) {
	std::string from = A(0).asString(rt).utf8(rt), to = A(1).asString(rt).utf8(rt);
	char err[1024];
	if (!rename_file(from.c_str(), to.c_str(), err, sizeof err)) throwAs(rt, "Error", err);
	return jsi::Value::undefined();
}

HOST_FN(removeFile) {
	std::string path = A(0).asString(rt).utf8(rt);
	char err[512];
	if (!remove_file(path.c_str(), err, sizeof err)) throwAs(rt, "Error", err);
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
	char err[128];
	InflateStream *s = inflate_open(in, len, err, sizeof err);
	if (!s) throwAs(rt, "Error", err);
	jsi::Object obj(rt);
	obj.setNativeState(rt, std::make_shared<Inflate>(s));
	return obj;
}

// -> ArrayBuffer of up to `max` inflated bytes, or null once the body is out.
HOST_FN(inflateRead) {
	std::shared_ptr<Inflate> h = stateOf<Inflate>(rt, A(0));
	if (!h) throwAs(rt, "TypeError", "not an inflate stream");
	char err[128];
	size_t n;
	uint8_t *out = inflate_read(h->s, (size_t)A(1).asNumber(), &n, err, sizeof err);
	if (!out) {
		if (err[0]) throwAs(rt, "Error", err);
		return jsi::Value::null();
	}
	return ownedBuffer(rt, out, n);
}

// gzip body -> ArrayBuffer of the inflated bytes.
HOST_FN(gunzip) {
	size_t len;
	uint8_t *in = mustBytes(rt, A(0), &len);
	char err[128];
	size_t n;
	uint8_t *out = gunzip_all(in, len, &n, err, sizeof err);
	if (!out) throwAs(rt, "Error", err);
	return ownedBuffer(rt, out, n);
}

// http(method, host, port, path, headerLines, body|null) -> { status, body }.
HOST_FN(http) {
	std::string method = A(0).asString(rt).utf8(rt), host = A(1).asString(rt).utf8(rt), path = A(3).asString(rt).utf8(rt), lines = A(4).asString(rt).utf8(rt);
	int port = (int)A(2).asNumber();
	std::string body;
	bool hasBody = A(5).isString();
	if (hasBody) body = A(5).getString(rt).utf8(rt);
	char err[512];
	HttpAnswer a;
	if (!http_request(method.c_str(), host.c_str(), port, path.c_str(), lines.c_str(), hasBody ? body.data() : nullptr, body.size(), &a, err, sizeof err)) throwAs(rt, "Error", err);
	jsi::Object out(rt);
	out.setProperty(rt, names->status, a.status);
	out.setProperty(rt, names->body, copiedBuffer(rt, a.body, a.body_len));
	free(a.buf);
	return out;
}

HOST_FN(print) {
	std::string s = A(0).asString(rt).utf8(rt);
	fwrite(s.data(), 1, s.size(), stdout);
	fputc('\n', stdout);
	fflush(stdout);
	return jsi::Value::undefined();
}

HOST_FN(now) { return jsi::Value(wall_ms()); }
HOST_FN(hrtime) { return jsi::Value(mono_ms()); }

HOST_FN(randomUUID) {
	char s[37];
	if (!random_uuid(s)) throwAs(rt, "Error", "no /dev/urandom");
	return jsi::String::createFromAscii(rt, s, 36);
}

facebook::hermes::HermesRuntime *hermesRt;

// Resident memory of the process now and at its peak; `deep` adds the JS
// heap after a full collection (Hermes counts bytes, not objects).
HOST_FN(mem) {
	jsi::Object o(rt);
	o.setProperty(rt, names->rssKb, (double)status_kb("VmRSS"));
	o.setProperty(rt, names->peakRssKb, (double)status_kb("VmHWM"));
	if (A(0).isBool() && A(0).getBool()) {
		hermesRt->instrumentation().collectGarbage("spike mem");
		auto info = hermesRt->instrumentation().getHeapInfo(false);
		o.setProperty(rt, names->jsHeapKb, (double)(info["hermes_allocatedBytes"] / 1024));
	}
	return o;
}

HOST_FN(gc) {
	hermesRt->instrumentation().collectGarbage("spike gc");
	return jsi::Value::undefined();
}

HOST_FN(setBlobWrap) {
	delete blobWrap;
	blobWrap = new jsi::Function(A(0).asObject(rt).asFunction(rt));
	return jsi::Value::undefined();
}

#undef A
#undef HOST_FN

// A file's bytes for evaluateJavaScript, source or bytecode.
struct FileBuffer : jsi::Buffer {
	uint8_t *p;
	size_t n;
	FileBuffer(uint8_t *p, size_t n) : p(p), n(n) {}
	~FileBuffer() override { free(p); }
	size_t size() const override { return n; }
	const uint8_t *data() const override { return p; }
};

int failed;

void dumpError(const jsi::JSError &e) {
	fprintf(stderr, "%s\n%s\n", e.getMessage().c_str(), e.getStack().c_str());
	fflush(stderr);
	failed = 1;
}

// argv[0] is a name; the files, then `--` and the script's arguments.
// Exits the process when the script is done (no teardown, as host.c).
int hostMain(int argc, char **argv) {
	auto config = hermes::vm::RuntimeConfig::Builder()
		// Promise jobs wait for the loop below, as QuickJS's do.
		.withMicrotaskQueue(true)
		// For source evaluated at run time; the bundle's bytecode is compiled
		// with the same (scripts/bundle.mjs).
		.withES6BlockScoping(true)
		.build();
	// Never destroyed: the process ends without teardown (host.c's reason),
	// and the values held for the host would outlive it.
	hermesRt = facebook::hermes::makeHermesRuntime(config).release();
	jsi::Runtime &rt = *hermesRt;

	names = new Names{
		jsi::PropNameID::forAscii(rt, "buffer"), jsi::PropNameID::forAscii(rt, "byteOffset"), jsi::PropNameID::forAscii(rt, "byteLength"),
		jsi::PropNameID::forAscii(rt, "status"), jsi::PropNameID::forAscii(rt, "body"), jsi::PropNameID::forAscii(rt, "changes"),
		jsi::PropNameID::forAscii(rt, "lastInsertRowid"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "errcode"),
		jsi::PropNameID::forAscii(rt, "rssKb"), jsi::PropNameID::forAscii(rt, "peakRssKb"), jsi::PropNameID::forAscii(rt, "jsHeapKb"),
	};
	uint8ArrayCtor = new jsi::Function(rt.global().getPropertyAsFunction(rt, "Uint8Array"));

	int split = 1;
	while (split < argc && strcmp(argv[split], "--") != 0) split++;

	jsi::Object host(rt);
	struct Fn { const char *name; unsigned params; jsi::HostFunctionType fn; };
	const Fn fns[] = {
		{ "dbOpen", 3, dbOpen }, { "dbClose", 1, dbClose }, { "dbExec", 2, dbExec }, { "dbAutocommit", 1, dbAutocommit },
		{ "dbPrepare", 2, dbPrepare }, { "stmtRun", 2, stmtRun }, { "stmtGet", 3, stmtGet }, { "stmtAll", 3, stmtAll },
		{ "stmtIterStart", 2, stmtIterStart }, { "stmtIterNext", 2, stmtIterNext }, { "stmtReset", 1, stmtReset },
		{ "hash", 3, hash }, { "hashOpen", 1, hashOpen }, { "hashUpdate", 2, hashUpdate }, { "hashDigest", 2, hashDigest }, { "readText", 1, readText }, { "readBytes", 1, readBytes }, { "writeText", 2, writeText }, { "writeBytes", 3, writeBytes },
		{ "fileSize", 1, fileSize }, { "renameFile", 2, renameFile }, { "removeFile", 1, removeFile },
		{ "utf8Decode", 1, utf8Decode }, { "utf8Encode", 1, utf8Encode }, { "gunzip", 1, gunzip },
		{ "inflateOpen", 1, inflateOpen }, { "inflateRead", 2, inflateRead }, { "http", 6, http }, { "print", 1, print },
		{ "now", 0, now }, { "hrtime", 0, hrtime }, { "randomUUID", 0, randomUUID }, { "mem", 1, mem }, { "gc", 0, gc },
		{ "setBlobWrap", 1, setBlobWrap },
	};
	for (const Fn &f : fns) host.setProperty(rt, f.name, jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, f.name), f.params, f.fn));
	jsi::Array args(rt, (size_t)(argc > split ? argc - split - 1 : 0));
	for (int i = split + 1; i < argc; i++) args.setValueAtIndex(rt, (size_t)(i - split - 1), jsi::String::createFromUtf8(rt, argv[i]));
	host.setProperty(rt, "args", args);
	host.setProperty(rt, "engine", jsi::String::createFromAscii(rt, "hermes " SPIKE_HERMES_VERSION));
	host.setProperty(rt, "sqlite", jsi::String::createFromAscii(rt, sqlite3_libversion()));
	rt.global().setProperty(rt, "__host", host);

	for (int i = 1; i < split && !failed; i++) {
		char err[512];
		size_t len;
		uint8_t *src = read_file(argv[i], &len, err, sizeof err);
		if (!src) { fprintf(stderr, "%s\n", err); failed = 1; break; }
		try {
			rt.evaluateJavaScript(std::make_shared<FileBuffer>(src, len), argv[i]);
		} catch (const jsi::JSError &e) {
			dumpError(e);
		} catch (const std::exception &e) {
			fprintf(stderr, "%s\n", e.what());
			failed = 1;
		}
	}

	// Promise jobs until none is left, then one task (setImmediate, a timer)
	// from the script's own queue; done when both are empty.
	while (!failed) {
		try {
			while (!rt.drainMicrotasks()) {}
			jsi::Value tick = rt.global().getProperty(rt, "__tick");
			if (!tick.isObject() || !tick.getObject(rt).isFunction(rt)) break;
			jsi::Value more = tick.getObject(rt).getFunction(rt).call(rt);
			if (!(more.isBool() && more.getBool())) break;
		} catch (const jsi::JSError &e) {
			dumpError(e);
		} catch (const std::exception &e) {
			fprintf(stderr, "%s\n", e.what());
			failed = 1;
		}
	}

	int exitCode = 0;
	try {
		jsi::Value code = rt.global().getProperty(rt, "__exitCode");
		if (code.isNumber()) exitCode = (int)code.getNumber();
	} catch (...) {}
	fflush(stdout);
	fflush(stderr);
	// No teardown, as host.c: not of the engine, not of the Java runtime.
	_exit(failed ? 1 : exitCode);
}

} // namespace

// spike.Main.run(String[] args) (host/java/spike/Main.java), on the runtime's main
// thread, which is attached to the VM as fbjni needs.
extern "C" JNIEXPORT jint JNICALL Java_spike_Main_run(JNIEnv *env, jclass, jobjectArray jargs) {
	std::vector<std::string> owned{ "spikehost" };
	jsize n = env->GetArrayLength(jargs);
	for (jsize i = 0; i < n; i++) {
		auto s = (jstring)env->GetObjectArrayElement(jargs, i);
		const char *c = env->GetStringUTFChars(s, nullptr);
		owned.emplace_back(c);
		env->ReleaseStringUTFChars(s, c);
		env->DeleteLocalRef(s);
	}
	std::vector<char *> argv;
	for (std::string &s : owned) argv.push_back(s.data());
	return hostMain((int)argv.size(), argv.data());
}
