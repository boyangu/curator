package app.curator.mobile.model

import app.curator.mobile.data.Library
import kotlinx.serialization.Serializable
import kotlin.math.max
import kotlin.math.min

/*
 * An artist's or a label's page (ui/entity/): the header the core answers
 * (js/entity.ts, the desktop's EntityHeader shape: packages/shared types.ts),
 * its World list a page of catalogue releases at a time, its My Library list
 * the library's own files. Everything here is the page's arithmetic: which
 * releases a scope and the filters leave, the chart's bars, how far the
 * header has faded. The views only draw it.
 */

// ── what the core answers ───────────────────────────────────────────────────

@Serializable
data class EntityRef(val kind: String, val name: String, val libraryId: String? = null, val catalogId: String? = null) {
	val isLabel: Boolean get() = kind == "label"
}

@Serializable
data class EntityChip(val ref: EntityRef, val count: Int? = null)

@Serializable
data class ReachPart(val provider: String, val metric: String, val n: Double, val at: Long, val outlier: Boolean = false)

@Serializable
data class ArtistReach(val score: Double, val change: Double? = null, val at: Long, val parts: List<ReachPart> = emptyList())

@Serializable
data class ArtistActivity(val firstRelease: String? = null, val lastRelease: String? = null)

@Serializable
data class EntityGenre(val name: String, val count: Int? = null)

@Serializable
data class EntityLink(val source: String, val sourceId: String, val url: String? = null)

@Serializable
data class EntityFollow(val following: Boolean, val muted: Boolean = false)

/** What My Library lists: the library artist's tracks, or the tracks whose label folds to one of these. */
@Serializable
data class OwnedFilter(val artistIds: List<String> = emptyList(), val labelFolds: List<String> = emptyList())

@Serializable
data class EntityOwned(val count: Int = 0, val filter: OwnedFilter? = null)

@Serializable
data class EntityWorld(
	val available: Boolean,
	val reason: String,
	val releaseCount: Int? = null,
	val trackCount: Int? = null,
	val candidates: List<EntityChip> = emptyList(),
	/** The streaming service World is read from while the catalogue does not know the entity ("spotify"); null: the catalogue. */
	val via: String? = null,
)

@Serializable
data class EntityHeader(
	val ref: EntityRef,
	val imageUrl: String? = null,
	val genres: List<EntityGenre> = emptyList(),
	val labels: List<EntityChip> = emptyList(),
	val artists: List<EntityChip> = emptyList(),
	val similar: List<EntityChip> = emptyList(),
	val collabs: List<EntityChip> = emptyList(),
	val activity: ArtistActivity? = null,
	val reach: ArtistReach? = null,
	val links: List<EntityLink> = emptyList(),
	val follow: EntityFollow? = null,
	val owned: EntityOwned = EntityOwned(),
	val world: EntityWorld,
)

@Serializable
data class Credit(val id: String? = null, val name: String)

@Serializable
data class AlbumLabel(val id: String? = null, val name: String)

@Serializable
data class WorldAlbum(
	val id: String,
	val title: String,
	val date: String? = null,
	val coverUrl: String? = null,
	val label: AlbumLabel? = null,
	val artists: List<Credit> = emptyList(),
	val genres: List<String> = emptyList(),
	val trackCount: Int = 0,
)

@Serializable
data class WorldTrack(
	val recordingId: String,
	val releaseId: String,
	val title: String,
	val artists: List<Credit> = emptyList(),
	val durationSec: Double? = null,
	val bpm: Double? = null,
	val keyCamelot: String? = null,
	val genre: String? = null,
	val streamIds: Map<String, String> = emptyMap(),
	val libraryTrackId: String? = null,
)

@Serializable
data class WorldPage(
	val albums: List<WorldAlbum> = emptyList(),
	val tracks: List<WorldTrack> = emptyList(),
	val nextCursor: String? = null,
	/** An artist page's library artist, found from the page's recordings the library holds. */
	val libraryId: String? = null,
)

// ── the page's rows, either scope ───────────────────────────────────────────

/** One track row: a catalogue recording (World) or a library track (My Library). */
data class EntityRow(
	val id: String,
	val title: String,
	val version: String?,
	val artists: List<Credit>,
	val durationSec: Double?,
	val bpm: Double?,
	val key: String?,
	val coverUrl: String?,
	/** The library track it is, when the library has it. */
	val libraryTrackId: String?,
	val spotifyId: String?,
) {
	val inLibrary: Boolean get() = libraryTrackId != null
	val artistLine: String get() = artists.joinToString(", ") { it.name }
}

data class EntityRelease(
	val id: String,
	val title: String,
	val artists: List<Credit>,
	val date: String?,
	val label: AlbumLabel?,
	val genre: String?,
	val coverUrl: String?,
	val tracks: List<EntityRow>,
	/** What the catalogue says it holds, its tracklist read or not. */
	val trackCount: Int,
) {
	val year: String? get() = date?.take(4)?.takeIf { it.length == 4 && it.all(Char::isDigit) }
	val seconds: Double get() = tracks.sumOf { it.durationSec ?: 0.0 }

	/** One key when every track that has one shares it. */
	val key: String? get() = tracks.mapNotNull { it.key?.uppercase() }.distinct().singleOrNull()

	/** "125 BPM", or "124–126" over a release's tracks. */
	val bpmText: String? get() {
		val all = tracks.mapNotNull { it.bpm?.let(Math::round) }
		if (all.isEmpty()) return null
		val lo = all.min()
		val hi = all.max()
		return if (lo == hi) "$lo BPM" else "$lo–$hi"
	}
}

enum class Scope { OWNED, WORLD }

enum class EntityTab { RELEASES, TRACKS }

/**
 * How this phone opens an artist's (or a label's) page: the list and the
 * sections drawn as charts last chosen on one of that kind. View state, kept
 * per device (ViewState); a page opened before the choice keeps its own.
 */
@Serializable
data class EntityView(val tab: EntityTab? = null, val charts: Set<EntitySection> = emptySet()) {
	/** An artist opens on its tracks, a label on its releases, until one is picked. */
	fun tabFor(kind: String): EntityTab = tab ?: if (kind == "label") EntityTab.RELEASES else EntityTab.TRACKS

	fun chartsFor(kind: String): Set<EntitySection> = charts intersect EntitySection.of(kind).toSet()
}

/**
 * The catalogue's releases with their tracklists, in the order the pages came.
 * [patches]: what the page's store reading found since, by recording
 * (model PageWork): shown at once, before the catalogue says it too.
 */
fun worldReleases(pages: List<WorldPage>, patches: Map<String, RowPatch> = emptyMap()): List<EntityRelease> {
	// A row is a recording on a release: pages read again while the catalogue
	// changes can overlap, and a recording counts once per release.
	val tracksOf = pages.flatMap { it.tracks }.distinctBy { it.releaseId to it.recordingId }.map { it.filled(patches[it.recordingId]) }.groupBy { it.releaseId }
	return pages.flatMap { it.albums }.distinctBy { it.id }.map { a ->
		EntityRelease(
			id = a.id, title = a.title, artists = a.artists, date = a.date, label = a.label,
			genre = a.genres.firstOrNull(), coverUrl = a.coverUrl, trackCount = a.trackCount,
			tracks = (tracksOf[a.id] ?: emptyList()).map { t ->
				// Title and version split as the library's own rows are.
				val (title, version) = Library.splitVersion(t.title)
				EntityRow(t.recordingId, title, version, t.artists, t.durationSec, t.bpm, t.keyCamelot, a.coverUrl, t.libraryTrackId, t.streamIds["spotify"])
			},
		)
	}
}

/** A library track as My Library groups it: [albumKey] is its album row, else its folded album title. */
data class OwnedTrack(
	val id: String,
	val title: String,
	val version: String?,
	val artists: List<String>,
	val album: String?,
	val albumKey: String?,
	val label: String?,
	val genre: String?,
	val released: String?,
	val durationSec: Int?,
	val bpm: Double?,
	val key: String?,
	val coverUrl: String?,
)

/**
 * The releases that hold at least one owned track: the owned tracks grouped
 * by album, newest first. A track with no album stands as its own release.
 */
fun ownedReleases(tracks: List<OwnedTrack>): List<EntityRelease> =
	tracks.groupBy { it.albumKey ?: it.album?.let(::searchFold)?.takeIf(String::isNotEmpty) ?: "track:${it.id}" }.values.map { group ->
		val first = group.first()
		EntityRelease(
			id = "owned:" + (first.albumKey ?: first.id),
			title = first.album?.takeIf { it.isNotBlank() } ?: first.title,
			artists = group.flatMap { t -> t.artists }.distinct().map { Credit(name = it) },
			date = group.mapNotNull { it.released }.maxOrNull(),
			label = group.firstNotNullOfOrNull { it.label?.takeIf(String::isNotBlank) }?.let { AlbumLabel(name = it) },
			genre = group.firstNotNullOfOrNull { it.genre?.takeIf(String::isNotBlank) },
			coverUrl = group.firstNotNullOfOrNull { it.coverUrl },
			trackCount = group.size,
			tracks = group.map { t -> EntityRow(t.id, t.title, t.version, t.artists.map { Credit(name = it) }, t.durationSec?.toDouble(), t.bpm, t.key, t.coverUrl, t.id, null) },
		)
	}.sortedByDescending { it.date ?: "" }

/** What the list holds in a scope, the filters applied: the catalogue's releases, or those holding an owned track. */
fun scopedReleases(scope: Scope, pages: List<WorldPage>, owned: List<OwnedTrack>?, filters: Filters, patches: Map<String, RowPatch> = emptyMap()): List<EntityRelease> =
	(if (scope == Scope.WORLD) worldReleases(pages, patches) else ownedReleases(owned ?: emptyList())).filter { it.matches(filters) }

/**
 * The Tracks tab: each recording once, at the release it first came out on
 * (the releases are newest first). One on an album and a compilation, or on
 * a release the catalogue holds twice, is one row; the list keys rows by
 * recording, and a repeated key ends the app.
 */
fun tabTracks(releases: List<EntityRelease>): List<EntityRow> =
	releases.flatMap { it.tracks }.asReversed().distinctBy { it.id }.asReversed()

/** The Releases and Tracks tabs' counts: the catalogue's in World, the library's own in My Library (null until read). */
fun tabCounts(scope: Scope, world: EntityWorld, owned: List<OwnedTrack>?, loaded: List<EntityRelease> = emptyList()): Pair<Int?, Int?> =
	if (scope == Scope.WORLD) {
		// The catalogue's counts as the header read them; tracklists the page's
		// work fills since show more than that before the header is read again.
		val releases = loaded.size
		val tracks = tabTracks(loaded).size
		(world.releaseCount?.let { maxOf(it, releases) } ?: releases.takeIf { it > 0 }) to (world.trackCount?.let { maxOf(it, tracks) } ?: tracks.takeIf { it > 0 })
	} else owned?.let { ownedReleases(it).size to it.size } ?: (null to null)

// ── the attribute sections ──────────────────────────────────────────────────

enum class EntitySection(val title: String, val chartable: Boolean, val initial: Int) {
	LABELS("Labels", true, 3),
	ARTISTS("Artists", true, 6),
	GENRES("Genres", false, Int.MAX_VALUE),
	COLLABS("Collabs", true, 3),
	ACTIVE("Active", true, 3);

	companion object {
		fun of(kind: String): List<EntitySection> = if (kind == "label") listOf(ARTISTS, GENRES, ACTIVE) else listOf(LABELS, GENRES, COLLABS, ACTIVE)
	}
}

/** A value a section names: a label or an artist (with its catalogue id when it has one), or a year. */
data class Pick(val name: String, val id: String? = null)

data class Item(val pick: Pick, val count: Int)

/** The section's values with their counts, as the names view lists them. */
fun sectionItems(s: EntitySection, h: EntityHeader, releases: List<EntityRelease>): List<Item> = when (s) {
	EntitySection.LABELS -> h.labels.map { Item(Pick(it.ref.name, it.ref.catalogId), it.count ?: 0) }
	EntitySection.ARTISTS -> h.artists.map { Item(Pick(it.ref.name, it.ref.catalogId), it.count ?: 0) }
	EntitySection.COLLABS -> h.collabs.map { Item(Pick(it.ref.name, it.ref.catalogId), it.count ?: 0) }
	EntitySection.GENRES -> h.genres.map { Item(Pick(it.name), it.count ?: 0) }
	EntitySection.ACTIVE -> yearCounts(releases)
}

/**
 * Releases per year, from the releases loaded so far (the catalogue gives no
 * per-year breakdown): most first, a tie newest first. Never more than what
 * is loaded — the chart grows as pages come.
 */
fun yearCounts(releases: List<EntityRelease>): List<Item> =
	releases.mapNotNull { it.year }.groupingBy { it }.eachCount().entries
		.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenByDescending { it.key })
		.map { Item(Pick(it.key), it.value) }

/** "2021–2026", the Active section's names view. */
fun activeRange(a: ArtistActivity?, releases: List<EntityRelease>): String? {
	val years = releases.mapNotNull { it.year }
	val from = a?.firstRelease?.take(4) ?: years.minOrNull()
	val to = a?.lastRelease?.take(4) ?: years.maxOrNull()
	return when {
		from == null || to == null -> null
		from == to -> from
		else -> "$from–$to"
	}
}

/** How many a section shows after [steps] presses of "Show more": its first few, then 5 more each. */
fun shownCount(s: EntitySection, total: Int, steps: Int): Int = min(total, if (s.initial == Int.MAX_VALUE) total else s.initial + 5 * steps)

/** What the next "Show {x} more" adds: 5, or what is left. */
fun moreStep(total: Int, shown: Int): Int = min(5, max(0, total - shown))

/** The chart's bars: the shown items, most first, each as a share of the largest. */
fun bars(items: List<Item>): List<Pair<Item, Float>> {
	val sorted = items.sortedByDescending { it.count }
	val top = sorted.firstOrNull()?.count?.takeIf { it > 0 } ?: return sorted.map { it to 0f }
	return sorted.map { it to it.count.toFloat() / top }
}

// ── filters ─────────────────────────────────────────────────────────────────

/** At most one value per section. */
typealias Filters = Map<EntitySection, Pick>

fun Filters.toggled(s: EntitySection, p: Pick): Filters = if (this[s] == p) this - s else this + (s to p)

/** A section's chart turned off takes its filter with it; the others stay. */
fun Filters.chartOff(s: EntitySection): Filters = this - s

private fun sameName(a: String?, b: String?): Boolean = a != null && b != null && searchFold(a).let { it.isNotEmpty() && it == searchFold(b) }

private fun names(c: Credit, p: Pick): Boolean = (p.id != null && c.id == p.id) || sameName(c.name, p.name)

/** Whether a release passes every section's filter (AND across sections). Its tracks go with it. */
fun EntityRelease.matches(f: Filters): Boolean = f.all { (s, p) ->
	when (s) {
		EntitySection.LABELS -> label != null && ((p.id != null && label.id == p.id) || sameName(label.name, p.name))
		EntitySection.ARTISTS, EntitySection.COLLABS -> artists.any { names(it, p) } || tracks.any { t -> t.artists.any { names(it, p) } }
		EntitySection.ACTIVE -> year == p.name
		EntitySection.GENRES -> sameName(genre, p.name)
	}
}

// ── the header's words ──────────────────────────────────────────────────────

/** Row 2's band: "26 releases", or in My Library "3 releases in library". */
/** [from]: the streaming service's name World is read from while the catalogue does not know the entity (the desktop's words). */
fun releasesLine(scope: Scope, count: Int?, from: String? = null): String? {
	if (count == null) return null
	val word = if (count == 1) "release" else "releases"
	return when {
		scope == Scope.OWNED -> "$count $word in library"
		from != null -> "$count $word on $from"
		else -> "$count $word"
	}
}

/** Why the World side can't be read, in the desktop's words (EntityHeader.tsx worldOffText). */
fun worldOffText(reason: String, kind: String): String? = when (reason) {
	"signed_out" -> "Sign in to Curator Cloud to browse the catalogue"
	"server_off" -> "The catalogue is not reachable right now"
	"old_server" -> "Curator Cloud needs an update before it can list the catalogue here"
	"ambiguous" -> "Several labels share this name. Pick the one you mean:"
	"unknown" -> "The catalogue does not know this $kind yet"
	"pending" -> "Asking the catalogue…"
	else -> null
}

fun noLocalText(kind: String): String = "No local files by this ${if (kind == "label") "label" else "artist"} yet"

/** "120 tracks from 40 of 43 releases so far. Scroll for more." while World has pages to come. */
fun coverageText(tracks: Int, releases: Int, total: Int?, more: Boolean): String? {
	if (!more) return null
	val of = if (total != null && total > releases) " of $total" else ""
	return "$tracks tracks from $releases$of releases so far. Scroll for more."
}

/** "686", "1,500", "15k", "1.3M", "12M": a Reach part's audience, as the desktop counts (format.ts fmtCount). */
fun audience(n: Double): String = when {
	n >= 1_000_000 -> (n / 1_000_000).let { v -> if (v >= 10) "${Math.round(v)}M" else String.format(java.util.Locale.US, "%.1f", v).removeSuffix(".0") + "M" }
	n >= 10_000 -> "${Math.round(n / 1000)}k"
	n >= 1_000 -> String.format(java.util.Locale.US, "%,d", Math.round(n))
	else -> Math.round(n).toString()
}

// ── the sticky header ───────────────────────────────────────────────────────
// Driven by how far the page has scrolled (dp), no animation of its own.

object Sticky {
	const val FADE_DP = 180f
	const val BAR_FROM_DP = 150f
	const val DOCK_DP = 230f

	/** The hero's bands: gone linearly over the first 180dp. */
	fun heroAlpha(y: Float): Float = (1f - y / FADE_DP).coerceIn(0f, 1f)

	/** The top bar's background, from clear to solid between 150 and 230dp. */
	fun barAlpha(y: Float): Float = ((y - BAR_FROM_DP) / (DOCK_DP - BAR_FROM_DP)).coerceIn(0f, 1f)

	/** The name sits in the bar once the hero has mostly gone. */
	fun docked(y: Float): Boolean = y >= DOCK_DP
}
