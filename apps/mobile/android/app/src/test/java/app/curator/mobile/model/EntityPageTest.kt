package app.curator.mobile.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EntityPageTest {
	private fun album(id: String, date: String?, label: AlbumLabel? = null, artists: List<Credit> = emptyList(), tracks: Int = 1) =
		WorldAlbum(id = id, title = "Release $id", date = date, label = label, artists = artists, trackCount = tracks)

	private fun track(id: String, release: String, artists: List<Credit> = emptyList(), lib: String? = null) =
		WorldTrack(recordingId = id, releaseId = release, title = "Track $id", artists = artists, durationSec = 300.0, libraryTrackId = lib)

	private fun owned(id: String, album: String?, key: String?, released: String?, artists: List<String> = listOf("Marsh"), label: String? = "Anjunadeep") =
		OwnedTrack(id, "Track $id", null, artists, album, key, label, "Melodic House", released, 300, 122.0, "9A", null)

	private val marsh = Credit("cat-marsh", "Marsh")
	private val yotto = Credit("cat-yotto", "Yotto")
	private val deep = AlbumLabel("cat-deep", "Anjunadeep")

	private val pages = listOf(
		WorldPage(
			albums = listOf(album("r1", "2025-03-01", deep, listOf(marsh)), album("r2", "2024-06-01", AlbumLabel(name = "Monada"), listOf(marsh, yotto), tracks = 2)),
			tracks = listOf(track("t1", "r1", listOf(marsh), lib = "lib-1"), track("t2", "r2", listOf(marsh)), track("t3", "r2", listOf(yotto))),
			nextCursor = "c1",
		),
		WorldPage(albums = listOf(album("r3", "2025-11-01", deep, listOf(Credit(name = "Marsh")))), tracks = listOf(track("t4", "r3"))),
	)
	private val world = EntityWorld(available = true, reason = "ok", releaseCount = 43, trackCount = 124)

	// ── scope ───────────────────────────────────────────────────────────────

	@Test fun `World counts are the catalogue's, My Library's the owned tracks and their release groups`() {
		val mine = listOf(owned("a", "Lailonie", "al1", "2026-03-01"), owned("b", "Lailonie", "al1", "2026-03-01"), owned("c", null, null, "2024-01-01"))
		assertEquals(43 to 124, tabCounts(Scope.WORLD, world, mine))
		assertEquals(2 to 3, tabCounts(Scope.OWNED, world, mine))
		assertEquals(null to null, tabCounts(Scope.OWNED, world, null))
		// Tracklists filled since the header was read count, the catalogue's figure never less.
		val filled = worldReleases(pages)
		assertEquals(3 to 4, tabCounts(Scope.WORLD, EntityWorld(available = true, reason = "ok", releaseCount = 2, trackCount = 0), mine, filled))
		assertEquals(43 to 124, tabCounts(Scope.WORLD, world, mine, filled))
		assertEquals(null to null, tabCounts(Scope.WORLD, EntityWorld(available = true, reason = "ok"), mine))
	}

	@Test fun `World lists every catalogue release, My Library only releases holding an owned track`() {
		val all = scopedReleases(Scope.WORLD, pages, emptyList(), emptyMap())
		assertEquals(listOf("r1", "r2", "r3"), all.map { it.id })
		assertEquals(listOf("t2", "t3"), all[1].tracks.map { it.id })
		assertTrue(all[0].tracks.single().inLibrary)
		assertTrue(scopedReleases(Scope.OWNED, pages, emptyList(), emptyMap()).isEmpty())
	}

	@Test fun `a recording on two releases is one Tracks row, at the release it first came out on`() {
		// r9 is the newest (a compilation holding t1 again); r1 the original.
		val twice = listOf(
			WorldPage(
				albums = listOf(album("r9", "2026-01-01"), album("r1", "2025-03-01")),
				tracks = listOf(track("t9", "r9"), track("t1", "r9"), track("t1", "r1"), track("t2", "r1")),
				nextCursor = "c1",
			),
			// A page read again after the catalogue moved: t2 on r1 comes twice.
			WorldPage(albums = listOf(album("r1", "2025-03-01")), tracks = listOf(track("t2", "r1"))),
		)
		val releases = worldReleases(twice)
		assertEquals(listOf("t9", "t1"), releases[0].tracks.map { it.id })
		assertEquals(listOf("t1", "t2"), releases[1].tracks.map { it.id })
		val rows = tabTracks(releases)
		assertEquals(listOf("t9", "t1", "t2"), rows.map { it.id })
		assertEquals(rows.size, rows.distinctBy { it.id }.size)
	}

	@Test fun `an artist opens on Tracks and a label on Releases until one is picked, then as picked`() {
		assertEquals(EntityTab.TRACKS, EntityView().tabFor("artist"))
		assertEquals(EntityTab.RELEASES, EntityView().tabFor("label"))
		assertEquals(EntityTab.RELEASES, EntityView(tab = EntityTab.RELEASES).tabFor("artist"))
		// A label's charts never carry an artist's sections, nor the other way round.
		val v = EntityView(charts = setOf(EntitySection.LABELS, EntitySection.ACTIVE))
		assertEquals(setOf(EntitySection.LABELS, EntitySection.ACTIVE), v.chartsFor("artist"))
		assertEquals(setOf(EntitySection.ACTIVE), v.chartsFor("label"))
		// Kept as JSON on the device (ViewState).
		val json = Json { ignoreUnknownKeys = true }
		assertEquals(v, json.decodeFromString<EntityView>(json.encodeToString(v)))
	}

	@Test fun `owned tracks group by album row, else folded album title, no album stands alone, newest first`() {
		val r = ownedReleases(listOf(
			owned("a", "Lailonie", "al1", "2026-03-01"),
			owned("b", "Lailonie", "al1", "2026-03-01", artists = listOf("Marsh", "Nox Vahn")),
			owned("c", "Brainwasher", null, "2025-01-01"),
			owned("d", "BRAINWASHER", null, "2025-01-01"),
			owned("e", null, null, "2024-01-01"),
		))
		assertEquals(listOf("Lailonie", "Brainwasher", "Track e"), r.map { it.title })
		assertEquals(listOf("a", "b"), r[0].tracks.map { it.id })
		assertEquals(listOf("Marsh", "Nox Vahn"), r[0].artists.map { it.name })
		assertEquals(2, r[1].tracks.size)
		assertTrue(r.all { rel -> rel.tracks.all { it.inLibrary } })
	}

	@Test fun `the releases band says in library in My Library`() {
		assertEquals("26 releases", releasesLine(Scope.WORLD, 26))
		assertEquals("1 release in library", releasesLine(Scope.OWNED, 1))
		assertEquals("3 releases in library", releasesLine(Scope.OWNED, 3))
		assertNull(releasesLine(Scope.WORLD, null))
		// World read from Spotify while the catalogue does not know the artist; My Library stays the library's.
		assertEquals("12 releases on Spotify", releasesLine(Scope.WORLD, 12, "Spotify"))
		assertEquals("2 releases in library", releasesLine(Scope.OWNED, 2, "Spotify"))
	}

	// ── filters ─────────────────────────────────────────────────────────────

	@Test fun `filters AND across sections, one value per section`() {
		val releases = worldReleases(pages)
		val byLabel: Filters = mapOf(EntitySection.LABELS to Pick("Anjunadeep", "cat-deep"))
		assertEquals(listOf("r1", "r3"), releases.filter { it.matches(byLabel) }.map { it.id })
		val labelAndYear = byLabel + (EntitySection.ACTIVE to Pick("2025"))
		assertEquals(listOf("r1", "r3"), releases.filter { it.matches(labelAndYear) }.map { it.id })
		val labelYearCollab = labelAndYear + (EntitySection.COLLABS to Pick("Yotto", "cat-yotto"))
		assertTrue(releases.none { it.matches(labelYearCollab) })
		// Another value in the same section replaces the first.
		val swapped = byLabel.toggled(EntitySection.LABELS, Pick("Monada"))
		assertEquals(1, swapped.size)
		assertEquals(listOf("r2"), releases.filter { it.matches(swapped) }.map { it.id })
		// The same value again takes it off.
		assertTrue(byLabel.toggled(EntitySection.LABELS, Pick("Anjunadeep", "cat-deep")).isEmpty())
	}

	@Test fun `an artist matches by catalogue id or by its folded name, on the release or its tracks`() {
		val releases = worldReleases(pages)
		val yottoById: Filters = mapOf(EntitySection.COLLABS to Pick("Yotto", "cat-yotto"))
		assertEquals(listOf("r2"), releases.filter { it.matches(yottoById) }.map { it.id })
		val marshByName: Filters = mapOf(EntitySection.ARTISTS to Pick("MARSH"))
		assertEquals(listOf("r1", "r2", "r3"), releases.filter { it.matches(marshByName) }.map { it.id })
	}

	@Test fun `turning a chart off clears that section's filter and keeps the others`() {
		val f: Filters = mapOf(EntitySection.LABELS to Pick("Anjunadeep"), EntitySection.ACTIVE to Pick("2025"))
		assertEquals(mapOf(EntitySection.ACTIVE to Pick("2025")), f.chartOff(EntitySection.LABELS))
	}

	// ── show more, charts ───────────────────────────────────────────────────

	@Test fun `show more adds five at a time from the section's first few`() {
		assertEquals(3, shownCount(EntitySection.LABELS, 14, 0))
		assertEquals(5, moreStep(14, 3))
		assertEquals(8, shownCount(EntitySection.LABELS, 14, 1))
		assertEquals(13, shownCount(EntitySection.LABELS, 14, 2))
		assertEquals(1, moreStep(14, 13))
		assertEquals(14, shownCount(EntitySection.LABELS, 14, 3))
		assertEquals(0, moreStep(14, 14))
		assertEquals(6, shownCount(EntitySection.ARTISTS, 12, 0))
		assertEquals(2, shownCount(EntitySection.COLLABS, 2, 0))
	}

	@Test fun `bars sort most first, each a share of the largest`() {
		val b = bars(listOf(Item(Pick("a"), 2), Item(Pick("b"), 8), Item(Pick("c"), 4)))
		assertEquals(listOf("b", "c", "a"), b.map { it.first.pick.name })
		assertEquals(listOf(1f, 0.5f, 0.25f), b.map { it.second })
	}

	@Test fun `releases per year come from the loaded releases only, most first, ties newest first`() {
		val first = yearCounts(worldReleases(pages.take(1)))
		assertEquals(listOf("2025" to 1, "2024" to 1), first.map { it.pick.name to it.count })
		val both = yearCounts(worldReleases(pages))
		assertEquals(listOf("2025" to 2, "2024" to 1), both.map { it.pick.name to it.count })
		assertTrue(yearCounts(emptyList()).isEmpty())
	}

	@Test fun `the Active range prefers the catalogue's dates`() {
		val releases = worldReleases(pages)
		assertEquals("2021–2026", activeRange(ArtistActivity("2021-02-01", "2026-01-09"), releases))
		assertEquals("2024–2025", activeRange(null, releases))
		assertNull(activeRange(null, emptyList()))
	}

	// ── the sticky header ───────────────────────────────────────────────────

	@Test fun `the hero fades over 180dp, the bar fills from 150 to 230, the name docks at 230`() {
		assertEquals(1f, Sticky.heroAlpha(0f))
		assertEquals(0.5f, Sticky.heroAlpha(90f))
		assertEquals(0f, Sticky.heroAlpha(400f))
		assertEquals(0f, Sticky.barAlpha(150f))
		assertEquals(0.5f, Sticky.barAlpha(190f))
		assertEquals(1f, Sticky.barAlpha(Float.MAX_VALUE))
		assertFalse(Sticky.docked(229f))
		assertTrue(Sticky.docked(230f))
	}

	// ── words, and the core's answer ────────────────────────────────────────

	@Test fun `status words follow the desktop's`() {
		assertEquals("The catalogue does not know this label yet", worldOffText("unknown", "label"))
		assertNull(worldOffText("ok", "artist"))
		assertEquals("No local files by this artist yet", noLocalText("artist"))
		assertEquals("120 tracks from 40 of 43 releases so far. Scroll for more.", coverageText(120, 40, 43, more = true))
		assertNull(coverageText(120, 43, 43, more = false))
		assertEquals("686", audience(686.0))
		assertEquals("1,500", audience(1_500.0))
		assertEquals("15k", audience(15_240.0))
		assertEquals("1.3M", audience(1_340_000.0))
		assertEquals("12M", audience(12_400_000.0))
	}

	@Test fun `a header from the core decodes, nulls and unknown keys and all`() {
		val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
		val h = json.decodeFromString<EntityHeader>(
			"""{"ref":{"kind":"artist","name":"Marsh","libraryId":null,"catalogId":"cat-marsh"},"imageUrl":null,"coverTrackId":null,"facts":{},
			"genres":[{"name":"Melodic House"}],"labels":[{"ref":{"kind":"label","name":"Anjunadeep","catalogId":"cat-deep"},"count":7}],
			"artists":[],"similar":[],"collabs":[],"activity":{"firstRelease":"2014-01-01","lastRelease":"2026-01-01","recentDays":730,"recentReleases":4,"recentTracks":9},
			"badges":["veteran"],"reach":{"score":31.9,"change":null,"at":1,"parts":[{"provider":"spotify","metric":"monthly_listeners","n":686,"at":1}]},
			"links":[{"source":"spotify","sourceId":"x","url":"https://open.spotify.com/artist/x"}],"follow":{"following":true,"muted":false},
			"owned":{"count":0,"filter":{"artistIds":["a1"],"hasSource":["local"]}},"world":{"available":true,"reason":"ok","releaseCount":26,"trackCount":null}}""",
		)
		assertEquals("cat-marsh", h.ref.catalogId)
		assertEquals(listOf("a1"), h.owned.filter?.artistIds)
		assertEquals(31.9, h.reach!!.score, 0.0)
		assertFalse(h.reach.parts.single().outlier)
		assertNull(h.world.trackCount)
	}
}
