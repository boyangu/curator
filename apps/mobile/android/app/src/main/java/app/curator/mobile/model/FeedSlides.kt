package app.curator.mobile.model

import kotlin.math.roundToInt

/** What the library says of a feed track. */
data class Held(
	val trackId: String,
	val interested: Boolean,
	/** There is a file of it (somewhere in the account's library). */
	val local: Boolean,
	val deleted: Boolean,
) {
	/** The desktop's "In Library" tier (feed/types.ts resolveFeedMembership). */
	val inLibrary: Boolean get() = !deleted && (interested || local)
}

/** What the library holds of the feed's tracks, by ISRC and by Spotify id. */
class Holdings(private val byIsrc: Map<String, Held>, private val bySpotifyId: Map<String, Held>) {
	/** The Spotify id first, as the desktop's cards read it; a live row before a deleted one. */
	fun of(isrc: String?, spotifyId: String?): Held? {
		val a = spotifyId?.let(bySpotifyId::get)
		val b = isrc?.let(byIsrc::get)
		return if (a != null && (!a.deleted || b == null || b.deleted)) a else b
	}

	fun of(t: FeedTrack): Held? = of(t.isrc, t.spotifyId)

	companion object { val EMPTY = Holdings(emptyMap(), emptyMap()) }
}

/** [NONE]: no heart here (a release's cover). [DIMMED]: shown, and says why it cannot be used. */
enum class Heart { NONE, OFF, ON, DIMMED }

/**
 * One slide of a card's image: what each corner says (§3 of the feed
 * handoff), the ribbon, the heart and what Play plays. A corner with nothing
 * to say is empty or null, and is not drawn.
 */
data class Slide(
	/** The track this slide is about; null on a release's cover. */
	val track: FeedTrack?,
	val held: Held?,
	/** Top left: title, then artists. */
	val topLeft: List<String>,
	/** Top right: "4 tracks" on a cover, "2/4" on its tracks. */
	val topRight: String?,
	/** Bottom left: label, then genre (a lone one takes the first line). */
	val bottomLeft: List<String>,
	/** Bottom right of a cover: the genre, in words. */
	val bottomRight: String?,
	/** Bottom right of a track, top to bottom. */
	val duration: String?,
	val bpm: String?,
	val key: String?,
	val ribbon: Boolean,
	val heart: Heart,
	/** What Play starts; null when Spotify can play none of it. */
	val plays: FeedTrack?,
)

/**
 * A card's slides: one for a track; a release's cover, then one per track.
 * [unavailable]: Spotify ids this account's market cannot play.
 */
fun slidesOf(item: FeedItem, holdings: Holdings, unavailable: Set<String> = emptySet()): List<Slide> {
	val tracks = item.tracks
	fun playable(t: FeedTrack) = t.spotifyId != null && t.spotifyId !in unavailable
	fun trackSlide(t: FeedTrack, position: String?): Slide {
		val held = holdings.of(t)
		return Slide(
			track = t, held = held,
			topLeft = lines(t.title, t.artists.joinToString(", ")),
			topRight = position,
			bottomLeft = lines(t.label, t.genre),
			bottomRight = null,
			duration = t.durationSec?.takeIf { it > 0 }?.let(::clock),
			bpm = t.bpm?.takeIf { it > 0 }?.roundToInt()?.toString(),
			key = t.key?.takeIf { it.isNotBlank() },
			ribbon = held?.inLibrary == true,
			heart = when {
				held?.deleted == true -> Heart.DIMMED
				held?.interested == true -> Heart.ON
				// A track the library holds can be marked whatever plays it; any
				// other needs the Spotify id that names it to the library.
				held != null || t.spotifyId != null -> Heart.OFF
				else -> Heart.DIMMED
			},
			plays = t.takeIf(::playable),
		)
	}
	if (!item.isRelease) return listOf(trackSlide(tracks.first(), null))
	val count = maxOf(tracks.size, item.payload.trackCount ?: 0)
	val cover = Slide(
		track = null, held = null,
		topLeft = emptyList(),
		topRight = if (count > 0) "$count ${if (count == 1) "track" else "tracks"}" else null,
		bottomLeft = lines(item.payload.label),
		bottomRight = item.payload.genre?.takeIf { it.isNotBlank() },
		duration = null, bpm = null, key = null,
		ribbon = false, heart = Heart.NONE,
		plays = tracks.firstOrNull(::playable),
	)
	return listOf(cover) + tracks.mapIndexed { i, t -> trackSlide(t, "${i + 1}/${tracks.size}") }
}

/** "m:ss", an hour and more "h:mm:ss". */
fun clock(sec: Double): String {
	val s = sec.roundToInt().coerceAtLeast(0)
	return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

private fun lines(vararg text: String?): List<String> = text.filterNot { it.isNullOrBlank() }.map { it!! }

/** Which of [count] dots are drawn with [at] current: all of a short gallery, else a window of [most] that keeps it inside. */
fun dotWindow(at: Int, count: Int, most: Int = 7): IntRange {
	if (count <= most) return 0 until count
	val first = (at - most / 2).coerceIn(0, count - most)
	return first until first + most
}
