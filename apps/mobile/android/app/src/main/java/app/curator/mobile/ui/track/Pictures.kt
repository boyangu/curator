package app.curator.mobile.ui.track

import androidx.compose.runtime.mutableStateMapOf
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.ui.AppModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/**
 * The player's artist and label pictures, from the Global Catalog (the core's
 * trackPictures; js/track-pictures.ts), kept by name on the device: a track
 * whose people are known asks nothing, and the round buttons draw initials
 * until a picture comes. A track is asked for once a run; one the catalogue
 * couldn't answer (offline, signed out) is asked again next time.
 */
class Pictures(private val model: AppModel) {
	private val known = mutableStateMapOf<String, String>()
	private val asked = HashSet<String>()
	private val file: File = model.app.files.trackPictures

	init {
		model.app.scope.launch {
			val kept = withContext(Dispatchers.IO) { runCatching { Json.decodeFromString<Map<String, String>>(file.readText()) }.getOrNull() } ?: return@launch
			kept.forEach { (k, v) -> known.putIfAbsent(k, v) }
		}
	}

	fun artist(name: String): String? = known[artistKey(name)]

	fun label(name: String): String? = known[labelKey(name)]

	/** Asks for [trackId]'s pictures unless every one of [artists] and [label] is known (main thread). */
	fun want(trackId: String, artists: List<String>, label: String?) {
		val missing = artists.any { artistKey(it) !in known } || (label != null && labelKey(label) !in known)
		if (!missing || !asked.add(trackId)) return
		model.app.scope.launch(Dispatchers.Main) {
			val r = runCatching { model.ask("trackPictures", "trackId" to JsonPrimitive(trackId)) as? JsonObject }
				.onFailure { DiagLog.w("ui", "trackPictures failed", it) }.getOrNull()
			if (r == null) { asked -= trackId; return@launch }
			val found = HashMap<String, String>()
			r["artists"]?.jsonArray?.forEach { a ->
				val o = a.jsonObject
				val name = o["name"]?.jsonPrimitive?.contentOrNull ?: return@forEach
				o["imageUrl"]?.jsonPrimitive?.contentOrNull?.let { found[artistKey(name)] = it }
			}
			(r["label"] as? JsonObject)?.let { o ->
				val name = o["name"]?.jsonPrimitive?.contentOrNull ?: return@let
				o["imageUrl"]?.jsonPrimitive?.contentOrNull?.let { found[labelKey(name)] = it }
			}
			if (found.isEmpty()) return@launch
			known.putAll(found)
			val all = known.toMap()
			withContext(Dispatchers.IO) {
				runCatching {
					val tmp = File(file.path + ".part")
					tmp.writeText(Json.encodeToString(all))
					tmp.renameTo(file)
				}.onFailure { DiagLog.w("ui", "keeping the track pictures failed", it) }
			}
		}
	}

	private fun artistKey(name: String) = "artist:" + name.trim().lowercase()
	private fun labelKey(name: String) = "label:" + name.trim().lowercase()
}
