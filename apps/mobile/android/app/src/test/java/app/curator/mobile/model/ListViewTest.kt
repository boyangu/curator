package app.curator.mobile.model

import app.curator.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ListViewTest {
	private fun t(id: String, bpm: Double? = null, key: String? = null, power: Double? = null, tags: List<String> = emptyList(), owned: Boolean = false, order: String? = id, added: Long? = null, title: String = id) =
		Track(id, null, title, null, "", null, null, null, null, bpm, key, null, null, power, null, null, null, added, if (owned) "local" else "spotify", tags, order)

	private val a = t("a", bpm = 118.0, key = "8A", power = 0.6, tags = listOf("p2"), owned = true, added = 3, title = "Beta")
	private val b = t("b", bpm = 122.0, key = "2B", power = 0.2, tags = listOf("p3", "build"), added = 1, title = "alpha")
	private val c = t("c", bpm = 126.0, key = "2A", power = null, tags = listOf("warm"), owned = true, added = 2, title = "Gamma")
	private val d = t("d", bpm = null, key = null, power = 0.9, added = null, title = "Delta")
	private val all = listOf(a, b, c, d)

	private fun ids(v: ListView) = v.apply(all).map { it.id }

	@Test fun `custom keeps the stored order`() = assertEquals(listOf("a", "b", "c", "d"), ids(ListView()))

	@Test fun `each sort, with missing values last in both directions`() {
		assertEquals(listOf("b", "a", "d", "c"), ids(ListView(sort = Sort.ENERGY)))
		assertEquals(listOf("d", "a", "b", "c"), ids(ListView(sort = Sort.ENERGY, dir = -1)))
		assertEquals(listOf("a", "b", "c", "d"), ids(ListView(sort = Sort.BPM)))
		assertEquals(listOf("c", "b", "a", "d"), ids(ListView(sort = Sort.BPM, dir = -1)))
		assertEquals(listOf("c", "b", "a", "d"), ids(ListView(sort = Sort.KEY)))
		assertEquals(listOf("b", "c", "a", "d"), ids(ListView(sort = Sort.ADDED)))
		assertEquals(listOf("b", "a", "d", "c"), ids(ListView(sort = Sort.TITLE)))
	}

	@Test fun `ties break on the key`() {
		val x = t("x", bpm = 122.0, key = "9A")
		val y = t("y", bpm = 122.0, key = "1B")
		assertEquals(listOf("y", "x"), ListView(sort = Sort.BPM).apply(listOf(x, y)).map { it.id })
	}

	@Test fun `tapping the active sort flips it, another starts ascending`() {
		val v = ListView(sort = Sort.BPM)
		assertEquals(-1, v.pick(Sort.BPM).dir)
		assertEquals(ListView(sort = Sort.KEY, dir = 1), v.pick(Sort.BPM).pick(Sort.KEY))
	}

	@Test fun `tag filter matches any selected tag, bpm buckets, owned only, clear`() {
		assertEquals(listOf("a", "b"), ids(ListView(tags = setOf("p2", "build"))))
		assertEquals(listOf("a"), ids(ListView(bpm = BpmBucket.LOW)))
		assertEquals(listOf("b"), ids(ListView(bpm = BpmBucket.MID)))
		assertEquals(listOf("c"), ids(ListView(bpm = BpmBucket.HIGH)))
		assertEquals(listOf("a", "c"), ids(ListView(ownedOnly = true)))
		val v = ListView(sort = Sort.BPM, tags = setOf("p2"), bpm = BpmBucket.LOW, ownedOnly = true)
		assertTrue(v.filtered)
		assertFalse(v.cleared().filtered)
		assertEquals(Sort.BPM, v.cleared().sort)
	}
}
