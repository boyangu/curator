package app.curator.mobile.diag

import android.util.Log
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The phone's log: every record to logcat, info and above kept on the device
 * ([LogStore]) for its owner to send or share (diag/Uploader, Settings). The
 * records are the desktop's shape (@curator/shared/log LogRecord); the sync
 * core's own arrive through [record].
 *
 * Never an email, a password, a one-time code or a token.
 */
object DiagLog {
	@Volatile
	private var store: LogStore? = null

	// One writer, off whatever thread is logging.
	private val writer = Executors.newSingleThreadExecutor { Thread(it, "curator-log").apply { isDaemon = true } }

	fun attach(s: LogStore) {
		store = s
	}

	fun d(area: String, msg: String) {
		Log.d("curator-$area", msg)
	}

	fun i(area: String, msg: String, data: Map<String, Any?>? = null) {
		Log.i("curator-$area", if (data == null) msg else "$msg $data")
		keep("info", area, msg, data, null)
	}

	fun w(area: String, msg: String, e: Throwable? = null, data: Map<String, Any?>? = null) {
		Log.w("curator-$area", if (data == null) msg else "$msg $data", e)
		keep("warn", area, msg, data, e)
	}

	fun e(area: String, msg: String, e: Throwable? = null, data: Map<String, Any?>? = null) {
		Log.e("curator-$area", if (data == null) msg else "$msg $data", e)
		keep("error", area, msg, data, e)
	}

	/** A record made elsewhere, as it is (the core's; logcat already has it). */
	fun record(r: JsonObject) {
		val s = store ?: return
		writer.execute { runCatching { s.append(r) } }
	}

	/** The process is going down: [record] and everything before it on disk first, or a second gone. */
	fun last(area: String, msg: String, e: Throwable?) {
		keep("error", area, msg, null, e)
		runCatching { writer.submit {}.get(1, TimeUnit.SECONDS) }
	}

	/** Runs on the log's own thread, after everything logged so far. */
	fun <T> flushed(read: (LogStore) -> T): T? {
		val s = store ?: return null
		return writer.submit<T> { read(s) }.get()
	}

	private fun keep(level: String, area: String, msg: String, data: Map<String, Any?>?, e: Throwable?) {
		if (store == null) return
		record(
			buildJsonObject {
				put("ts", System.currentTimeMillis())
				put("level", level)
				put("proc", "phone-ui")
				put("area", area)
				put("msg", msg)
				if (data != null) put("data", JsonObject(data.mapValues { (_, v) -> v.toJson() }))
				if (e != null) put("err", errOf(e))
			},
		)
	}

	private fun errOf(e: Throwable): JsonObject = buildJsonObject {
		put("name", e.javaClass.name)
		put("message", (e.message ?: "").take(1_000))
		put("stack", e.stackTraceToString().take(4_000))
	}

	private fun Any?.toJson(): JsonElement = when (this) {
		is Number -> JsonPrimitive(this)
		is Boolean -> JsonPrimitive(this)
		else -> JsonPrimitive(this?.toString())
	}
}
