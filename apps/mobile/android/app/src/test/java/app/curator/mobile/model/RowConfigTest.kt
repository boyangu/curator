package app.curator.mobile.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RowConfigTest {
	private val d = TracklistRows.DEFAULTS
	private val l1 = Section(0, Side.L)
	private val r1 = Section(0, Side.R)
	private val l2 = Section(1, Side.L)
	private val r2 = Section(1, Side.R)

	@Test fun `defaults are valid and match the protocol's`() {
		assertTrue(d.isValid())
		assertEquals(2, d.density)
		assertEquals(listOf(listOf(RowField.TITLE), listOf(RowField.ARTIST, RowField.LABEL)), d.level(2).l)
		assertEquals(listOf(listOf(RowField.BPM, RowField.KEY), listOf(RowField.TIME), listOf(RowField.POWER)), d.level(3).r)
	}

	@Test fun `a field used in another section moves here and leaves there`() {
		// Level 2: time sits on line 2 right; tapping it with line 1 left selected moves it.
		val next = d.apply(RowEdit.Tap(2, l1, RowField.TIME))
		assertEquals(listOf(RowField.TITLE, RowField.TIME), next.level(2).section(l1))
		assertEquals(emptyList<RowField>(), next.level(2).section(r2))
		assertTrue(next.isValid())
	}

	@Test fun `tapping a field in this section removes it, an unused one is added at the end`() {
		val removed = d.apply(RowEdit.Tap(2, r1, RowField.KEY))
		assertEquals(listOf(RowField.BPM), removed.level(2).section(r1))
		val added = removed.apply(RowEdit.Tap(2, r1, RowField.RATING))
		assertEquals(listOf(RowField.BPM, RowField.RATING), added.level(2).section(r1))
		assertTrue(added.isValid())
	}

	@Test fun `the title cannot be removed, by remove or by tap`() {
		assertSame(d, d.apply(RowEdit.Remove(2, l1, RowField.TITLE)))
		assertSame(d, d.apply(RowEdit.Tap(2, l1, RowField.TITLE)))
	}

	@Test fun `the title can move to another section and stays once`() {
		val next = d.apply(RowEdit.Tap(2, r2, RowField.TITLE))
		assertEquals(emptyList<RowField>(), next.level(2).section(l1))
		assertEquals(listOf(RowField.TIME, RowField.TITLE), next.level(2).section(r2))
		assertTrue(next.isValid())
	}

	@Test fun `reorder swaps within a section and stops at the ends`() {
		val next = d.apply(RowEdit.Reorder(2, l2, 0, +1))
		assertEquals(listOf(RowField.LABEL, RowField.ARTIST), next.level(2).section(l2))
		assertSame(next, next.apply(RowEdit.Reorder(2, l2, 1, +1)))
		assertSame(next, next.apply(RowEdit.Reorder(2, l2, 0, -1)))
	}

	@Test fun `levels are independent and reset restores one level only`() {
		val edited = d.apply(RowEdit.Tap(1, r1, RowField.TIME)).apply(RowEdit.Tap(3, r1, RowField.RATING))
		val reset = edited.apply(RowEdit.Reset(1))
		assertEquals(d.level(1), reset.level(1))
		assertEquals(listOf(RowField.BPM, RowField.KEY, RowField.RATING), reset.level(3).section(r1))
	}

	@Test fun `json round trip, and invalid stored values are refused`() {
		val edited = d.apply(RowEdit.Tap(2, r1, RowField.RATING)).copy(density = 3)
		assertEquals(edited, TracklistRows.fromJson(edited.toJson()))
		val twice = Json.parseToJsonElement("""{"density":1,"levels":{"1":{"l":[["title","bpm"]],"r":[["bpm"]]},"2":{"l":[["title"],[]],"r":[[],[]]},"3":{"l":[["title"],[],[]],"r":[[],[],[]]}}}""")
		assertNull(TracklistRows.fromJson(twice))
		val noTitle = Json.parseToJsonElement("""{"density":1,"levels":{"1":{"l":[["artist"]],"r":[[]]},"2":{"l":[["title"],[]],"r":[[],[]]},"3":{"l":[["title"],[],[]],"r":[[],[],[]]}}}""")
		assertNull(TracklistRows.fromJson(noTitle))
		val wrongLines = Json.parseToJsonElement("""{"density":1,"levels":{"1":{"l":[["title"],[]],"r":[[],[]]},"2":{"l":[["title"],[]],"r":[[],[]]},"3":{"l":[["title"],[],[]],"r":[[],[],[]]}}}""")
		assertNull(TracklistRows.fromJson(wrongLines))
		assertFalse(d.copy(density = 4).isValid())
	}
}
