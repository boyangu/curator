package app.curator.mobile.data

import java.io.Closeable

/**
 * A read connection to the library file, on the same SQLite the sync core
 * writes through (cpp/db_jni.cpp) — never Android's own SQLite or Room: two
 * SQLite builds locking one file in one process can corrupt it. WAL: a read
 * sees whole writes only and never blocks the core.
 *
 * Calls are serialised on the connection (SQLite multi-thread mode: one
 * thread at a time per connection); views read on IO dispatchers.
 */
class NativeDb private constructor(private var handle: Long) : Closeable {

	@Synchronized
	fun query(sql: String, vararg args: Any?): Rows {
		check(handle != 0L) { "the library is closed" }
		return Rows(nativeQuery(handle, sql, args))
	}

	@Synchronized
	override fun close() {
		if (handle != 0L) nativeClose(handle)
		handle = 0
	}

	companion object {
		fun open(path: String, readonly: Boolean = true): NativeDb = NativeDb(nativeOpen(path, readonly))

		@JvmStatic private external fun nativeOpen(path: String, readonly: Boolean): Long
		@JvmStatic private external fun nativeClose(handle: Long)
		@JvmStatic private external fun nativeQuery(handle: Long, sql: String, args: Array<out Any?>): Array<Any?>
	}
}

/** A query's answer: column names, then values row by row. */
class Rows(private val raw: Array<Any?>) : Iterable<Row> {
	@Suppress("UNCHECKED_CAST")
	val columns: Array<String> = raw[0] as Array<String>
	private val index: Map<String, Int> = columns.withIndex().associate { (i, c) -> c to i }
	val size: Int = if (columns.isEmpty()) 0 else (raw.size - 1) / columns.size

	operator fun get(row: Int): Row = Row(this, row)
	internal fun value(row: Int, col: Int): Any? = raw[1 + row * columns.size + col]
	internal fun col(name: String): Int = index[name] ?: error("no column $name")

	override fun iterator(): Iterator<Row> = (0 until size).asSequence().map { Row(this, it) }.iterator()
}

class Row(private val rows: Rows, private val i: Int) {
	fun any(col: String): Any? = rows.value(i, rows.col(col))
	fun string(col: String): String? = any(col) as String?
	fun long(col: String): Long? = (any(col) as Number?)?.toLong()
	fun int(col: String): Int? = (any(col) as Number?)?.toInt()
	fun double(col: String): Double? = (any(col) as Number?)?.toDouble()
	fun bytes(col: String): ByteArray? = any(col) as ByteArray?
	fun bool(col: String): Boolean = (any(col) as Number?)?.toLong()?.let { it != 0L } ?: false
}
