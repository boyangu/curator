package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Test

class SearchTest {
	private val index = SearchIndex(listOf("Ben Böhmer Breathing", "Fink More", "Klangkarussell More (Fink Remix)")) { it }

	@Test fun everyWordAnywhereFoldingCaseAndAccents() {
		assertEquals(listOf("Ben Böhmer Breathing"), index.search("bohmer BREATH"))
		assertEquals(listOf("Fink More", "Klangkarussell More (Fink Remix)"), index.search("more fink"))
		assertEquals(listOf("Klangkarussell More (Fink Remix)"), index.search("remix fink"))
	}

	@Test fun emptyQueryKeepsEverything() {
		assertEquals(3, index.search("  ").size)
	}
}
