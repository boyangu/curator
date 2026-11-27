package app.curator.mobile.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PageWorkTest {
	private fun event(json: String) = parseWork(Json.parseToJsonElement(json).jsonObject)

	// ── the core's `work` event ─────────────────────────────────────────────

	@Test fun `a status alone - no rows, nothing changed`() {
		val e = event("""{"type":"work","watch":7,"status":{"phase":"tracklists","store":"beatport","found":3,"done":2,"total":9}}""")!!
		assertEquals(7, e.watch)
		assertEquals(WorkStatus("tracklists", "beatport", 3, 2, 9), e.status)
		assertTrue(e.rows.isEmpty())
		assertFalse(e.changed)
	}

	@Test fun `rows carry only the facts found`() {
		val e = event(
			"""{"type":"work","watch":2,"status":{"phase":"details","store":"beatport","found":0,"done":1,"total":4},
				"rows":[{"recordingId":"rec-1","bpm":124,"keyCamelot":"8A","genre":"Melodic House & Techno"},{"recordingId":"rec-2","spotifyId":"sp2","label":"Anjunadeep"}]}""",
		)!!
		assertEquals(RowPatch("rec-1", bpm = 124.0, keyCamelot = "8A", genre = "Melodic House & Techno"), e.rows[0])
		assertEquals(RowPatch("rec-2", label = "Anjunadeep", spotifyId = "sp2"), e.rows[1])
	}

	@Test fun `the reading gone quiet - phase null - and the page to read again`() {
		val e = event("""{"type":"work","watch":3,"status":{"phase":null,"store":null,"found":5,"done":0,"total":0},"changed":true}""")!!
		assertNull(e.status.phase)
		assertNull(e.status.store)
		assertEquals(5, e.status.found)
		assertTrue(e.changed)
	}

	@Test fun `what an event leaves out or words anew is not its end`() {
		val e = event("""{"type":"work","watch":4,"status":{"phase":"listing","later":1},"rows":null,"soon":{"a":1}}""")!!
		assertEquals(WorkStatus("listing"), e.status)
		assertTrue(e.rows.isEmpty())
		assertEquals(WorkEvent(5), event("""{"type":"work","watch":5}"""))
	}

	@Test fun `an event that names no showing, or a row no recording, is dropped`() {
		assertNull(event("""{"type":"work","status":{"phase":"listing"}}"""))
		assertNull(event("""{"type":"work","watch":1,"rows":[{"bpm":120}]}"""))
	}

	// ── the page's line ─────────────────────────────────────────────────────

	@Test fun `the line says what is being read, and nothing when nothing is`() {
		assertEquals("Checking Beatport for new releases…", workLine(WorkStatus("listing", "beatport")))
		assertEquals("Checking Apple Music for new releases…", workLine(WorkStatus("listing", "apple")) { "Apple Music" })
		assertEquals("Checking stores for new releases…", workLine(WorkStatus("listing")))
		assertEquals("Reading tracklists · 2/9", workLine(WorkStatus("tracklists", "deezer", done = 2, total = 9)))
		assertEquals("Reading tracklists…", workLine(WorkStatus("tracklists")))
		assertEquals("Looking up BPM and key · 0/4", workLine(WorkStatus("details", "beatport", total = 4)))
		assertNull(workLine(WorkStatus(null, found = 3)))
		assertNull(workLine(WorkStatus("something new")))
		assertNull(workLine(null))
	}

	// ── what was found, over the rows ───────────────────────────────────────

	private fun track(id: String, bpm: Double? = null, key: String? = null, spotify: String? = null) =
		WorldTrack(recordingId = id, releaseId = "r1", title = "Track $id", bpm = bpm, keyCamelot = key, streamIds = spotify?.let { mapOf("spotify" to it) } ?: emptyMap())

	@Test fun `a patch fills what the catalogue left empty`() {
		val t = track("a").filled(RowPatch("a", bpm = 124.0, keyCamelot = "8A", spotifyId = "sp-a"))
		assertEquals(124.0, t.bpm)
		assertEquals("8A", t.keyCamelot)
		assertEquals("sp-a", t.streamIds["spotify"])
	}

	@Test fun `a patch never replaces what the catalogue says`() {
		val t = track("a", bpm = 122.0, key = "9A", spotify = "sp-own")
		assertSame(t, t.filled(RowPatch("a", bpm = 124.0, keyCamelot = "8A", spotifyId = "sp-other")))
		// One empty value filled, the others kept.
		val half = track("b", bpm = 122.0).filled(RowPatch("b", bpm = 99.0, keyCamelot = "8A"))
		assertEquals(122.0, half.bpm)
		assertEquals("8A", half.keyCamelot)
		assertNull(half.streamIds["spotify"])
	}

	@Test fun `no patch, or one with nothing for the row, leaves the track as it is`() {
		val t = track("a", bpm = 0.0, key = " ")
		assertSame(t, t.filled(null))
		assertSame(t, t.filled(RowPatch("a", genre = "House", label = "Monada")))
		// A zero BPM and a blank key are empty, and a found zero or blank fills nothing.
		assertSame(t, t.filled(RowPatch("a", bpm = 0.0, keyCamelot = "")))
		assertEquals(126.0, t.filled(RowPatch("a", bpm = 126.0)).bpm)
	}

	@Test fun `the rows of the list show the patches, by recording`() {
		val pages = listOf(
			WorldPage(
				albums = listOf(WorldAlbum(id = "r1", title = "Release", trackCount = 2)),
				tracks = listOf(track("a"), track("b", bpm = 120.0, key = "5A", spotify = "sp-b")),
			),
		)
		val plain = worldReleases(pages).single().tracks
		assertNull(plain[0].bpm)
		assertNull(plain[0].spotifyId)
		val rows = worldReleases(pages, mapOf("a" to RowPatch("a", bpm = 124.0, keyCamelot = "8A", spotifyId = "sp-a"), "b" to RowPatch("b", bpm = 99.0))).single().tracks
		assertEquals(listOf(124.0, 120.0), rows.map { it.bpm })
		assertEquals(listOf("8A", "5A"), rows.map { it.key })
		assertEquals(listOf("sp-a", "sp-b"), rows.map { it.spotifyId })
		// The same through the scope's list.
		assertEquals(rows, scopedReleases(Scope.WORLD, pages, null, emptyMap(), mapOf("a" to RowPatch("a", bpm = 124.0, keyCamelot = "8A", spotifyId = "sp-a"))).single().tracks)
	}

	@Test fun `a later batch stands over an earlier one, recording by recording`() {
		val first = emptyMap<String, RowPatch>().merged(listOf(RowPatch("a", bpm = 124.0), RowPatch("b", keyCamelot = "5A")))
		assertSame(first, first.merged(emptyList()))
		val next = first.merged(listOf(RowPatch("a", bpm = 124.0, keyCamelot = "8A")))
		assertEquals(RowPatch("a", bpm = 124.0, keyCamelot = "8A"), next["a"])
		assertEquals(RowPatch("b", keyCamelot = "5A"), next["b"])
	}
}
