package app.curator.mobile.ui.track

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import app.curator.mobile.ui.AppModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

/**
 * A track's waveform peaks: from the app's cache (files/peaks/<track>.cpk),
 * else fetched once by the sync core from the account's analysis catalogue
 * (js/entry.ts fetchPeaks), which leaves them in that cache. Null while that
 * runs, or when the account has none: the views draw a flat well with the
 * grid, cues and phrases.
 */
@Composable
fun rememberPeaks(model: AppModel, trackId: String): Peaks? {
	val peaks by produceState<Peaks?>(null, trackId) {
		val file = File(model.app.filesDir, "peaks/$trackId.cpk")
		suspend fun read() = withContext(Dispatchers.IO) { file.takeIf { it.exists() }?.readBytes()?.let { Peaks.parse(it) } }
		value = read()
		if (value != null) return@produceState
		val tier = runCatching { model.app.core.call("fetchPeaks", buildJsonObject { put("trackId", JsonPrimitive(trackId)) }) }.getOrNull()
		if (tier is JsonPrimitive && tier.isString) value = read()
	}
	return peaks
}
