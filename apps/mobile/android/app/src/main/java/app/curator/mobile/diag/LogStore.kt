package app.curator.mobile.diag

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/**
 * The log on the device: JSON lines in [dir], the newest in phone.log, older
 * ones phone.1.log and up, [files] of at most [fileBytes] in all. Every record
 * is numbered, so what was sent is known by one number and a batch sent twice
 * is stored once. The numbers belong to this install ([installId], which
 * outlives sign-ins); both are lost with the app's data, together.
 *
 * Used from one thread (DiagLog's).
 */
class LogStore(private val dir: File, private val fileBytes: Long = 2L * 1024 * 1024, private val files: Int = 4) {
	init {
		dir.mkdirs()
	}

	val installId: String = File(dir, "install-id").let { f ->
		runCatching { UUID.fromString(f.readText().trim()).toString() }.getOrElse { UUID.randomUUID().toString().also { f.writeText(it) } }
	}

	private val sentFile = File(dir, "sent")
	private fun file(i: Int) = File(dir, if (i == 0) "phone.log" else "phone.$i.log")

	private var next: Long = run {
		// The last whole line anywhere says; a line cut by a kill is skipped.
		val last = (0 until files).firstNotNullOfOrNull { i -> file(i).takeIf { it.exists() }?.useLines { l -> l.mapNotNull(::numberOf).lastOrNull() } }
		maxOf(last ?: -1, sent()) + 1
	}

	/** The last number the cloud took; -1 when none was. */
	fun sent(): Long = runCatching { sentFile.readText().trim().toLong() }.getOrDefault(-1)

	fun markSent(n: Long) {
		if (n <= sent()) return
		val tmp = File(sentFile.path + ".part")
		tmp.writeText(n.toString())
		Files.move(tmp.toPath(), sentFile.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
	}

	/** Nothing kept so far is sent any more (it stays to be shared). */
	fun skipUnsent() = markSent(next - 1)

	fun append(r: JsonObject) {
		val now = file(0)
		if (now.length() > fileBytes) rotate()
		val line = JsonObject(mapOf("n" to JsonPrimitive(next)) + r).toString()
		next++
		// A line cut by a kill must not take this one with it.
		val glue = if (now.exists() && now.length() > 0 && !endsWhole(now)) "\n" else ""
		now.appendText("$glue$line\n")
	}

	/** Unsent records, oldest first: at most [max], and about [maxBytes] of them. */
	fun unsent(max: Int, maxBytes: Int): List<JsonObject> {
		val after = sent()
		val out = ArrayList<JsonObject>()
		var bytes = 0
		for (i in files - 1 downTo 0) {
			val f = file(i)
			if (!f.exists()) continue
			f.useLines { lines ->
				for (line in lines) {
					val r = parse(line) ?: continue
					val n = r["n"]?.jsonPrimitive?.long ?: continue
					if (n <= after) continue
					bytes += line.length * 2
					if (out.isNotEmpty() && (out.size >= max || bytes > maxBytes)) return out
					out += r
				}
			}
		}
		return out
	}

	/** The whole log as one text file at [to], oldest first (Share logs). */
	fun export(to: File) {
		to.bufferedWriter().use { w ->
			for (i in files - 1 downTo 0) file(i).takeIf { it.exists() }?.forEachLine { w.appendLine(it) }
		}
	}

	private fun rotate() {
		file(files - 1).delete()
		for (i in files - 2 downTo 0) file(i).takeIf { it.exists() }?.renameTo(file(i + 1))
	}

	private fun endsWhole(f: File): Boolean = java.io.RandomAccessFile(f, "r").use { it.seek(it.length() - 1); it.read() == '\n'.code }

	private fun parse(line: String): JsonObject? = runCatching { Json.parseToJsonElement(line).jsonObject }.getOrNull()
	private fun numberOf(line: String): Long? = runCatching { parse(line)?.get("n")?.jsonPrimitive?.long }.getOrNull()
}
