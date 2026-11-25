package app.curator.mobile.model

import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

private const val DAY_MS = 86_400_000L

/**
 * The card's date, as the desktop's Discover cards say it (DiscoverView
 * fmtFeedDate): days for two weeks, weeks for two months, then the month,
 * with the year once it is not this one.
 */
fun feedDate(at: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
	val days = Math.floorDiv(now - at, DAY_MS)
	if (days < 14) return if (days <= 0) "today" else if (days == 1L) "1 day" else "$days days"
	if (days < 60) return "${days / 7} weeks"
	val d = Instant.ofEpochMilli(at).atZone(zone)
	val month = d.month.getDisplayName(TextStyle.SHORT, Locale.US)
	return if (d.year == Instant.ofEpochMilli(now).atZone(zone).year) month else "$month ${d.year}"
}

/** The same, as a screen reader says it: "Released today", "Added 3 days ago", "Released in Sep 2026". */
fun feedDateSpoken(item: FeedItem, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
	val label = feedDate(item.date, now, zone)
	val verb = if (item.isRelease) "Released" else "Added"
	return when {
		label == "today" -> "$verb today"
		label.endsWith("day") || label.endsWith("days") || label.endsWith("weeks") -> "$verb $label ago"
		else -> "$verb in $label"
	}
}

/** Line 1: who it is by. */
fun feedArtists(item: FeedItem): String = item.payload.artists.joinToString(", ")

/**
 * Line 2 of a card's header: a release's name; for a track, why it is here.
 * [owner]: the playlist's owner as the library knows it, for an origin that
 * does not say.
 */
fun feedSubtitle(item: FeedItem, owner: String? = null): String {
	if (item.isRelease) return item.payload.title
	val o = item.origin ?: return item.payload.albumTitle.orEmpty()
	return when (o.kind) {
		"playlist" -> {
			val by = o.owner?.name?.takeIf { it.isNotBlank() } ?: owner?.takeIf { it.isNotBlank() }
			if (by != null) "${o.name} · by $by" else o.name
		}
		"genre" -> if (o.rank != null) "${o.name} chart · #${o.rank}" else "${o.name} chart"
		"artist" -> "New from ${o.name}"
		"label" -> o.name
		else -> item.payload.albumTitle ?: o.name
	}
}

private val STORES = mapOf(
	"spotify" to "Spotify", "tidal" to "Tidal", "beatport" to "Beatport", "bandcamp" to "Bandcamp", "traxsource" to "Traxsource",
	"soundcloud" to "SoundCloud", "youtube" to "YouTube", "deezer" to "Deezer", "apple" to "Apple Music", "beatsource" to "Beatsource",
)

/** Where a card's link goes, and what that place is called; null when the item has no page anywhere. */
fun feedLink(item: FeedItem): Pair<String, String>? {
	val p = item.payload
	// A page on the web only: the link is handed to whichever app opens it.
	val url = (listOf(p.url) + p.handles.map { it.url }).firstOrNull { it != null && (it.startsWith("https://") || it.startsWith("http://")) } ?: return null
	val named = p.handles.firstOrNull { it.url == url }?.provider ?: STORES.keys.firstOrNull { host(url).contains(it) }
	return url to (STORES[named] ?: host(url))
}

private fun host(url: String): String = url.substringAfter("://").substringBefore('/').removePrefix("www.")
