package app.curator.mobile.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateFeedTest {
	private fun release(tag: String, draft: Boolean = false, prerelease: Boolean = false, manifest: Boolean = true) = """
		{"tag_name": "$tag", "draft": $draft, "prerelease": $prerelease, "html_url": "https://example/$tag",
		 "assets": [${if (manifest) """{"name": "update.json", "browser_download_url": "https://example/$tag/update.json"},""" else ""}
		  {"name": "curator-mobile.apk", "browser_download_url": "https://example/$tag/curator-mobile.apk"}]}
	""".trimIndent()

	@Test
	fun `the newest published mobile release, by version not by list order`() {
		val list = "[" + listOf(
			release("cloud-v0.9.0"),
			release("mobile-v0.9.0"),
			release("mobile-v0.10.0"),
			release("mobile-v1.0.0", draft = true),
			release("mobile-v0.11.0", prerelease = true),
			release("mobile-v0.12.0", manifest = false),
			release("mobile-v0.10.1-rc1"),
		).joinToString(",") + "]"
		val r = UpdateFeed.newest(list)!!
		assertEquals("mobile-v0.10.0", r.tag)
		assertEquals(10_000L, r.versionCode)
		assertEquals("https://example/mobile-v0.10.0/update.json", r.manifestUrl)
		assertEquals("https://example/mobile-v0.10.0/curator-mobile.apk", r.assets["curator-mobile.apk"])
	}

	@Test
	fun `no mobile release, nothing`() {
		assertNull(UpdateFeed.newest("[${release("cloud-v1.0.0")}]"))
		assertNull(UpdateFeed.newest("[]"))
	}

	@Test
	fun `version codes order as build-gradle makes them`() {
		assertEquals(1_002_003L, UpdateFeed.versionCode(1, 2, 3))
		assert(UpdateFeed.versionCode(0, 10, 0) > UpdateFeed.versionCode(0, 9, 999))
	}

	@Test
	fun `update json`() {
		val m = UpdateFeed.manifest("""{"version":"0.2.0","versionCode":2000,"apk":"curator-mobile-0.2.0.apk","sha256":"ab","size":12,"commit":"abc","extra":1}""")
		assertEquals("curator-mobile-0.2.0.apk", m.apk)
		assertEquals(2000L, m.versionCode)
	}
}
