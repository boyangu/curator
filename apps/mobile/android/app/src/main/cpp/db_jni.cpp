// The views' side of the library file (data/NativeDb.kt): the same SQLite the
// sync core writes through (js_host.cpp), so the process holds one SQLite
// build — two builds locking one file in one process can corrupt it. Read
// connections in WAL mode, so a read never blocks the core's writes nor sees
// half of one.
//
// A query answers one flat array: the column names, then every row's values
// in order (Long, Double, String, byte[] or null), which Kotlin wraps. Text
// crosses as real UTF-16 (native.h), not JNI's modified UTF-8.

#include "native.h"
#include "sqlite3.h"

#include <jni.h>

#include <string>
#include <vector>

namespace {

struct Classes {
	jclass object, string, longClass, doubleClass, integerClass, floatClass, booleanClass, bytes, sqliteException;
	jmethodID longValueOf, doubleValueOf, longValue, doubleValue, intValue, floatValue, booleanValue;
};
Classes *cls;

jclass globalClass(JNIEnv *env, const char *name) {
	jclass local = env->FindClass(name);
	jclass global = (jclass)env->NewGlobalRef(local);
	env->DeleteLocalRef(local);
	return global;
}

void init(JNIEnv *env) {
	if (cls) return;
	cls = new Classes();
	cls->object = globalClass(env, "java/lang/Object");
	cls->string = globalClass(env, "java/lang/String");
	cls->longClass = globalClass(env, "java/lang/Long");
	cls->doubleClass = globalClass(env, "java/lang/Double");
	cls->integerClass = globalClass(env, "java/lang/Integer");
	cls->floatClass = globalClass(env, "java/lang/Float");
	cls->booleanClass = globalClass(env, "java/lang/Boolean");
	cls->bytes = globalClass(env, "[B");
	cls->sqliteException = globalClass(env, "android/database/sqlite/SQLiteException");
	cls->longValueOf = env->GetStaticMethodID(cls->longClass, "valueOf", "(J)Ljava/lang/Long;");
	cls->doubleValueOf = env->GetStaticMethodID(cls->doubleClass, "valueOf", "(D)Ljava/lang/Double;");
	cls->longValue = env->GetMethodID(cls->longClass, "longValue", "()J");
	cls->doubleValue = env->GetMethodID(cls->doubleClass, "doubleValue", "()D");
	cls->intValue = env->GetMethodID(cls->integerClass, "intValue", "()I");
	cls->floatValue = env->GetMethodID(cls->floatClass, "floatValue", "()F");
	cls->booleanValue = env->GetMethodID(cls->booleanClass, "booleanValue", "()Z");
}

void throwSqlite(JNIEnv *env, sqlite3 *db, const std::string &what) {
	std::string msg = what + (db ? std::string(": ") + sqlite3_errmsg(db) : std::string());
	env->ThrowNew(cls->sqliteException, msg.c_str());
}

std::string stringOf(JNIEnv *env, jstring s) {
	const jchar *c = env->GetStringChars(s, nullptr);
	std::string out = utf8_of((const char16_t *)c, (size_t)env->GetStringLength(s));
	env->ReleaseStringChars(s, c);
	return out;
}

jstring jstringOf(JNIEnv *env, const char *p, size_t n) {
	std::u16string u = utf16_of(p, n);
	return env->NewString((const jchar *)u.data(), (jsize)u.size());
}

// False with a Java exception pending.
bool bindArg(JNIEnv *env, sqlite3_stmt *st, int i, jobject v) {
	int rc;
	if (v == nullptr) rc = sqlite3_bind_null(st, i);
	else if (env->IsInstanceOf(v, cls->longClass)) rc = sqlite3_bind_int64(st, i, env->CallLongMethod(v, cls->longValue));
	else if (env->IsInstanceOf(v, cls->integerClass)) rc = sqlite3_bind_int64(st, i, env->CallIntMethod(v, cls->intValue));
	else if (env->IsInstanceOf(v, cls->doubleClass)) rc = sqlite3_bind_double(st, i, env->CallDoubleMethod(v, cls->doubleValue));
	else if (env->IsInstanceOf(v, cls->floatClass)) rc = sqlite3_bind_double(st, i, env->CallFloatMethod(v, cls->floatValue));
	else if (env->IsInstanceOf(v, cls->booleanClass)) rc = sqlite3_bind_int(st, i, env->CallBooleanMethod(v, cls->booleanValue) ? 1 : 0);
	else if (env->IsInstanceOf(v, cls->string)) {
		std::string s = stringOf(env, (jstring)v);
		rc = sqlite3_bind_text(st, i, s.data(), (int)s.size(), SQLITE_TRANSIENT);
	} else if (env->IsInstanceOf(v, cls->bytes)) {
		auto arr = (jbyteArray)v;
		jsize n = env->GetArrayLength(arr);
		std::vector<jbyte> b((size_t)n);
		env->GetByteArrayRegion(arr, 0, n, b.data());
		rc = sqlite3_bind_blob(st, i, b.data(), (int)n, SQLITE_TRANSIENT);
	} else {
		env->ThrowNew(cls->sqliteException, "a query argument must be a number, a string, bytes, a boolean or null");
		return false;
	}
	if (rc != SQLITE_OK) { throwSqlite(env, sqlite3_db_handle(st), "bind"); return false; }
	return true;
}

jobject valueOf(JNIEnv *env, sqlite3_stmt *st, int c) {
	switch (sqlite3_column_type(st, c)) {
		case SQLITE_INTEGER: return env->CallStaticObjectMethod(cls->longClass, cls->longValueOf, (jlong)sqlite3_column_int64(st, c));
		case SQLITE_FLOAT: return env->CallStaticObjectMethod(cls->doubleClass, cls->doubleValueOf, sqlite3_column_double(st, c));
		case SQLITE_TEXT: return jstringOf(env, (const char *)sqlite3_column_text(st, c), (size_t)sqlite3_column_bytes(st, c));
		case SQLITE_BLOB: {
			jsize n = sqlite3_column_bytes(st, c);
			jbyteArray b = env->NewByteArray(n);
			if (n > 0) env->SetByteArrayRegion(b, 0, n, (const jbyte *)sqlite3_column_blob(st, c));
			return b;
		}
		default: return nullptr;
	}
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_app_curator_mobile_data_NativeDb_nativeOpen(JNIEnv *env, jclass, jstring path, jboolean readonly) {
	init(env);
	std::string p = stringOf(env, path);
	sqlite3 *db = nullptr;
	int flags = (readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE) | SQLITE_OPEN_FULLMUTEX;
	if (sqlite3_open_v2(p.c_str(), &db, flags, nullptr) != SQLITE_OK) {
		throwSqlite(env, db, "open " + p);
		sqlite3_close(db);
		return 0;
	}
	sqlite3_extended_result_codes(db, 1);
	sqlite3_busy_timeout(db, 5000);
	return (jlong)(intptr_t)db;
}

JNIEXPORT void JNICALL Java_app_curator_mobile_data_NativeDb_nativeClose(JNIEnv *, jclass, jlong h) {
	sqlite3_close_v2((sqlite3 *)(intptr_t)h);
}

// -> [String[] columns, values...]: rows × columns values, row by row.
JNIEXPORT jobjectArray JNICALL Java_app_curator_mobile_data_NativeDb_nativeQuery(JNIEnv *env, jclass, jlong h, jstring sql, jobjectArray args) {
	init(env);
	auto *db = (sqlite3 *)(intptr_t)h;
	std::string q = stringOf(env, sql);
	sqlite3_stmt *st = nullptr;
	if (sqlite3_prepare_v2(db, q.c_str(), (int)q.size() + 1, &st, nullptr) != SQLITE_OK) { throwSqlite(env, db, "prepare"); return nullptr; }
	jsize nargs = args ? env->GetArrayLength(args) : 0;
	for (jsize i = 0; i < nargs; i++) {
		jobject v = env->GetObjectArrayElement(args, i);
		bool ok = bindArg(env, st, i + 1, v);
		if (v) env->DeleteLocalRef(v);
		if (!ok) { sqlite3_finalize(st); return nullptr; }
	}
	int ncol = sqlite3_column_count(st);
	jobjectArray names = env->NewObjectArray(ncol, cls->string, nullptr);
	for (int c = 0; c < ncol; c++) {
		const char *n = sqlite3_column_name(st, c);
		jstring s = jstringOf(env, n, strlen(n));
		env->SetObjectArrayElement(names, c, s);
		env->DeleteLocalRef(s);
	}
	// Values go straight into the answer, which doubles when full: no
	// reference is held per value (a list of 40k ids would overflow the VM's
	// reference tables), and the answer is trimmed to size at the end.
	jsize cap = 1 + ncol * 64, len = 1;
	jobjectArray out = env->NewObjectArray(cap, cls->object, nullptr);
	env->SetObjectArrayElement(out, 0, names);
	env->DeleteLocalRef(names);
	auto grow = [&](jsize want) {
		jsize next = cap;
		while (next < want) next *= 2;
		if (next == cap) return;
		jobjectArray bigger = env->NewObjectArray(next, cls->object, nullptr);
		for (jsize i = 0; i < len; i++) {
			jobject v = env->GetObjectArrayElement(out, i);
			env->SetObjectArrayElement(bigger, i, v);
			if (v) env->DeleteLocalRef(v);
		}
		env->DeleteLocalRef(out);
		out = bigger;
		cap = next;
	};
	int rc;
	while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
		grow(len + ncol);
		for (int c = 0; c < ncol; c++) {
			jobject v = valueOf(env, st, c);
			if (v) { env->SetObjectArrayElement(out, len, v); env->DeleteLocalRef(v); }
			len++;
		}
	}
	if (rc != SQLITE_DONE) {
		env->DeleteLocalRef(out);
		throwSqlite(env, db, "step");
		sqlite3_finalize(st);
		return nullptr;
	}
	sqlite3_finalize(st);
	if (len == cap) return out;
	jobjectArray exact = env->NewObjectArray(len, cls->object, nullptr);
	for (jsize i = 0; i < len; i++) {
		jobject v = env->GetObjectArrayElement(out, i);
		env->SetObjectArrayElement(exact, i, v);
		if (v) env->DeleteLocalRef(v);
	}
	env->DeleteLocalRef(out);
	return exact;
}

} // extern "C"
