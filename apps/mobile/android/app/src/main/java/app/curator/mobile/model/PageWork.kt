package app.curator.mobile.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/*
 * What the core says of the store reading it does for the artist or label
 * page in front (js/work.ts, its `work` events): where the reading is, the
 * facts it found for rows the page already shows, and that the catalogue kept
 * something of the page. The page's words for it and the rows' patching are
 * here; the page (ui/entity/EntityPageModel) only keeps them.
 */

/** [phase]: listing, tracklists or details; null when nothing is being read. */
@Serializable
data class WorkStatus(val phase: String? = null, val store: String? = null, val found: Int = 0, val done: Int = 0, val total: Int = 0)

/** What the reading found for one recording; each fact only when it found it. */
@Serializable
data class RowPatch(
	val recordingId: String,
	val bpm: Double? = null,
	val keyCamelot: String? = null,
	val genre: String? = null,
	val label: String? = null,
	val spotifyId: String? = null,
)

/** [watch]: the number the page was watched with; [changed]: the catalogue kept something of the page, which reads it again. */
@Serializable
data class WorkEvent(val watch: Int, val status: WorkStatus = WorkStatus(), val rows: List<RowPatch> = emptyList(), val changed: Boolean = false)

// A null where a number or a list is expected reads as the default: an event
// the core words a little differently one day still says what it can.
private val workJson = Json { ignoreUnknownKeys = true; coerceInputValues = true }

/** The core's `work` event; null for one that can't be read (no watch number, a row without its recording). */
fun parseWork(e: JsonObject): WorkEvent? = runCatching { workJson.decodeFromJsonElement<WorkEvent>(e) }.getOrNull()

/** The page's quiet line while stores are read for it; null when nothing is. [storeName]: how the store is called. */
fun workLine(s: WorkStatus?, storeName: (String) -> String = { it.replaceFirstChar(Char::uppercase) }): String? = when (s?.phase) {
	"listing" -> "Checking ${s.store?.takeIf(String::isNotBlank)?.let(storeName) ?: "stores"} for new releases…"
	"tracklists" -> "Reading tracklists${progress(s)}"
	"details" -> "Looking up BPM and key${progress(s)}"
	else -> null
}

private fun progress(s: WorkStatus): String = if (s.total > 0) " · ${s.done}/${s.total}" else "…"

/**
 * A catalogue track with what the reading found for it: BPM, key and the
 * Spotify id fill what the catalogue left empty and never replace what it
 * says. The same object when there is nothing to fill.
 */
fun WorldTrack.filled(p: RowPatch?): WorldTrack {
	if (p == null) return this
	val has = streamIds["spotify"]
	val tempo = if (bpm == null || bpm <= 0) p.bpm?.takeIf { it > 0 } ?: bpm else bpm
	val key = if (keyCamelot.isNullOrBlank()) p.keyCamelot?.takeIf(String::isNotBlank) ?: keyCamelot else keyCamelot
	val spotify = if (has.isNullOrBlank()) p.spotifyId?.takeIf(String::isNotBlank) ?: has else has
	if (tempo == bpm && key == keyCamelot && spotify == has) return this
	return copy(bpm = tempo, keyCamelot = key, streamIds = if (spotify != null) streamIds + ("spotify" to spotify) else streamIds)
}

/** The patches so far with a newer batch over them: the core sends each recording's whole patch every time. */
fun Map<String, RowPatch>.merged(rows: List<RowPatch>): Map<String, RowPatch> = if (rows.isEmpty()) this else this + rows.associateBy { it.recordingId }
