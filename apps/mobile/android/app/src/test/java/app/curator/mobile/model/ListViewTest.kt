package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// How the view's sorts and filters read rows is ListQueryTest's (they run in SQL).
class ListViewTest {
	@Test fun `tapping the active sort flips it, another starts ascending`() {
		val v = ListView(sort = Sort.BPM)
		assertEquals(-1, v.pick(Sort.BPM).dir)
		assertEquals(ListView(sort = Sort.KEY, dir = 1), v.pick(Sort.BPM).pick(Sort.KEY))
	}

	@Test fun `clearing keeps the sort`() {
		val v = ListView(sort = Sort.BPM, tags = setOf("p2"), bpm = BpmBucket.LOW, ownedOnly = true)
		assertTrue(v.filtered)
		assertFalse(v.cleared().filtered)
		assertEquals(Sort.BPM, v.cleared().sort)
	}
}
