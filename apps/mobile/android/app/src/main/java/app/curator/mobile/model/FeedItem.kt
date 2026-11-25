package app.curator.mobile.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * A feed item as feed.db holds it (packages/sync-core feed/types.ts), as far
 * as the cards read it. Every field a card can do without has a default: the
 * stored payload is whatever the event's card said when it was raised.
 */
@Serializable
data class FeedHandle(val provider: String, val id: String, val url: String? = null)

@Serializable
data class FeedTrackRef(
	val sourceTrackId: String,
	val title: String = "",
	val artists: List<String> = emptyList(),
	val durationSec: Double? = null,
	val trackNumber: Int? = null,
	val isrc: String? = null,
	val bpm: Double? = null,
	val keyCamelot: String? = null,
	val genre: String? = null,
	val label: String? = null,
	val catalogId: String? = null,
	val handles: List<FeedHandle> = emptyList(),
)

@Serializable
data class FeedPayload(
	val title: String = "",
	val artists: List<String> = emptyList(),
	val artistIds: List<String> = emptyList(),
	val artistCatalogIds: List<String?> = emptyList(),
	val label: String? = null,
	val isrc: String? = null,
	val bpm: Double? = null,
	val keyCamelot: String? = null,
	val genre: String? = null,
	val coverUrl: String? = null,
	val albumTitle: String? = null,
	val trackCount: Int? = null,
	val durationSec: Double? = null,
	val url: String? = null,
	val tracks: List<FeedTrackRef>? = null,
	val handles: List<FeedHandle> = emptyList(),
)

@Serializable
data class FeedOwner(val id: String, val name: String? = null)

/** Why an item is here: `kind` is playlist, artist, label, genre or browse. */
@Serializable
data class FeedOrigin(val kind: String, val id: String = "", val name: String = "", val rank: Int? = null, val owner: FeedOwner? = null)

data class FeedItem(
	val id: String,
	/** "track" or "album". */
	val type: String,
	val source: String,
	val sourceId: String,
	val payload: FeedPayload,
	val origin: FeedOrigin?,
	/** When it came out (a release) or was added (a playlist track); else when it was read. */
	val date: Long,
	val state: String,
) {
	val isRelease: Boolean get() = type == "album"

	/** One track a card can show: the item's own, or one of a release's. */
	val tracks: List<FeedTrack> get() = if (!isRelease) listOf(ownTrack()) else payload.tracks.orEmpty().map(::refTrack)

	private fun ownTrack() = FeedTrack(
		sourceTrackId = null, title = payload.title, artists = payload.artists, label = payload.label, genre = payload.genre, durationSec = payload.durationSec,
		bpm = payload.bpm, key = payload.keyCamelot, isrc = payload.isrc, spotifyId = payload.handles.spotifyId() ?: sourceId.takeIf { source == "spotify" },
	)

	// A release's label and genre stand in for a track's own.
	private fun refTrack(t: FeedTrackRef) = FeedTrack(
		sourceTrackId = t.sourceTrackId, title = t.title, artists = t.artists, label = t.label ?: payload.label, genre = t.genre ?: payload.genre,
		durationSec = t.durationSec, bpm = t.bpm, key = t.keyCamelot, isrc = t.isrc,
		// feed/handles.ts trackSpotifyIdOf: a track Spotify lacks carries its
		// catalogue id where the Spotify id would be.
		spotifyId = t.handles.spotifyId() ?: t.sourceTrackId.takeIf { source == "spotify" && it != t.catalogId },
	)
}

/** [sourceTrackId] names a release's track to the core; null is a track item's own. */
data class FeedTrack(
	val sourceTrackId: String?,
	val title: String,
	val artists: List<String>,
	val label: String?,
	val genre: String?,
	val durationSec: Double?,
	val bpm: Double?,
	val key: String?,
	val isrc: String?,
	/** Null: the Spotify player cannot play it, and the library cannot name it (yet). */
	val spotifyId: String?,
)

private fun List<FeedHandle>.spotifyId(): String? = firstOrNull { it.provider == "spotify" }?.id

/** One artist a card credits: what the picture is asked for and cached under. */
data class FeedArtist(val name: String, val catalogId: String?, val spotifyId: String?) {
	val key: String? get() = catalogId ?: spotifyId
}

/** Its artists in credit order. `artistIds` hold the Spotify id, or `catalog:<uuid>` where there is none. */
val FeedPayload.credits: List<FeedArtist>
	get() = artists.mapIndexed { i, name ->
		val id = artistIds.getOrNull(i)?.takeIf { it.isNotEmpty() }
		FeedArtist(name, artistCatalogIds.getOrNull(i) ?: id?.takeIf { it.startsWith("catalog:") }?.removePrefix("catalog:"), id?.takeUnless { it.startsWith("catalog:") })
	}

object FeedJson {
	private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

	/** Null for a payload this build cannot read: the card is left out rather than shown wrong. */
	fun payload(text: String): FeedPayload? = runCatching { json.decodeFromString<FeedPayload>(text) }.getOrNull()

	fun origin(text: String?): FeedOrigin? = text?.let { runCatching { json.decodeFromString<FeedOrigin>(it) }.getOrNull() }
}
