package app.curator.mobile.data

import app.curator.mobile.model.FeedJson
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.sql.Connection
import java.sql.DriverManager

/**
 * The feed's statements against a real SQLite with the store's own tables:
 * its DDL and the live feed's predicate are read out of the store's source,
 * so a change there that these reads cannot follow fails here.
 */
class FeedDbTest {
	private val store = generateSequence(File("").absoluteFile) { it.parentFile }
		.map { File(it, "packages/sync-core/src/feed/store.ts") }.first { it.exists() }.readText().replace("\r\n", "\n")

	private fun constant(name: String) = Regex("const $name = `(.*?)`;", RegexOption.DOT_MATCHES_ALL).find(store)!!.groupValues[1]

	private val db: Connection = DriverManager.getConnection("jdbc:sqlite::memory:").apply {
		createStatement().use { s ->
			s.executeUpdate(constant("DDL"))
			s.executeUpdate("CREATE VIEW feed_visible AS SELECT * FROM feed_item WHERE ${constant("VISIBLE_WHERE")}")
			for (sql in listOf(
				"CREATE TABLE track (id TEXT PRIMARY KEY, isrc TEXT, remote_source TEXT, deleted_at INTEGER, derived_from_track_id TEXT)",
				"CREATE TABLE track_tag (track_id TEXT, tag_id TEXT)",
				"CREATE TABLE claim_link (track_id TEXT, source TEXT, source_track_id TEXT, PRIMARY KEY (track_id, source, source_track_id)) WITHOUT ROWID",
				"CREATE TABLE playlist (id TEXT, source TEXT, source_id TEXT, owner_name TEXT)",
			)) s.execute(sql)
		}
	}

	@After fun close() = db.close()

	private fun exec(sql: String, vararg args: Any?) = db.prepareStatement(sql).use { st -> args.forEachIndexed { i, v -> st.setObject(i + 1, v) }; st.execute() }

	private fun item(id: String, at: Long, type: String = "track", state: String = "fresh", source: String = "spotify", sourceId: String = "sp-$id", payload: String = """{"title":"$id"}""", covered: String? = null) =
		exec(
			"INSERT INTO feed_item (id, type, source, source_id, dedupe_key, payload_json, fetched_at, order_ts, state, covered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, type, source, sourceId, "k:$id", payload, at, at, state, covered,
		)

	private fun rows(text: String, args: Array<Any?> = emptyArray()): List<Map<String, Any?>> = db.prepareStatement(text).use { st ->
		args.forEachIndexed { i, v -> st.setObject(i + 1, v) }
		st.executeQuery().use { rs -> buildList { while (rs.next()) add((1..rs.metaData.columnCount).associate { rs.metaData.getColumnLabel(it) to rs.getObject(it) }) } }
	}

	private fun rows(q: Sql) = rows(q.text, q.args)
	private fun ids() = rows(FeedSql.ROWS).map { it["id"] }

	@Test fun `newest first, the live feed and the tracks taken from it`() {
		item("a", 3); item("b", 5, "album"); item("c", 4, state = "promoted"); item("d", 2, state = "seen")
		item("archived", 9, state = "archived"); item("dismissed", 9, state = "dismissed"); item("covered", 9, covered = "b")
		item("list", 9, "playlist"); item("set", 9, "set"); item("gone", 9, state = "promoted", covered = "b")
		assertEquals(listOf("b", "c", "a", "d"), ids())
	}

	@Test fun `a muted artist's tracks leave, a release that credits them stays`() {
		item("t", 2); item("r", 1, "album")
		for (i in listOf("t", "r")) exec("INSERT INTO feed_item_key VALUES (?, 'artist:x')", i)
		exec("INSERT INTO feed_suppression (id, scope, key, at) VALUES ('s', 'artist', 'artist:x', 1)")
		assertEquals(listOf("r"), ids())
	}

	@Test fun `every track's ISRC and Spotify id, a release's one by one`() {
		item("a", 5, payload = """{"title":"a","isrc":"GB1"}""")
		item("b", 4, source = "catalog", sourceId = "cat-b", payload = """{"title":"b","handles":[{"provider":"deezer","id":"1"},{"provider":"spotify","id":"spb"}]}""")
		item("c", 3, source = "catalog", sourceId = "cat-c")
		item("r", 2, "album", payload = """{"title":"r","tracks":[
			{"sourceTrackId":"st1","isrc":"GB2","catalogId":"c1","handles":[{"provider":"spotify","id":"st1"}]},
			{"sourceTrackId":"c2","catalogId":"c2","handles":[{"provider":"deezer","id":"9"}]},
			{"sourceTrackId":"st3","isrc":"GB3"}]}""")
		item("empty", 1, "album")
		assertEquals(
			listOf(listOf("a", "GB1", "sp-a"), listOf("b", null, "spb"), listOf("c", null, null), listOf("r", "GB2", "st1"), listOf("r", "GB3", "st3"), listOf("r", null, null)),
			rows(FeedSql.KEYS).map { listOf(it["id"], it["isrc"], it["spotify_id"]) }.sortedBy { it.toString() },
		)
	}

	@Test fun `the library's word on each track, by ISRC and by a claimed Spotify id`() {
		exec("INSERT INTO track VALUES ('t1', 'GB1', 'local', NULL, NULL), ('t2', 'GB2', 'spotify', NULL, NULL), ('t3', 'GB3', 'spotify', 7, NULL), ('wav', 'GB2', 'local', NULL, 't2')")
		exec("INSERT INTO track_tag VALUES ('t2', 'interested'), ('t1', 'basket')")
		exec("INSERT INTO claim_link VALUES ('t2', 'spotify', 'sp2'), ('t1', 'tidal', 'sp1')")
		fun said(q: Sql) = rows(q).map { listOf(it["k"], it["id"], it["local"], it["deleted"], it["interested"]) }.toSet()
		assertEquals(
			setOf(listOf("GB1", "t1", 1, 0, 0), listOf("GB2", "t2", 0, 0, 1), listOf("GB3", "t3", 0, 1, 0)),
			said(FeedSql.heldByIsrc(listOf("GB1", "GB2", "GB3", "GB9"))),
		)
		assertEquals(setOf(listOf("sp2", "t2", 0, 0, 1)), said(FeedSql.heldBySpotifyId(listOf("sp1", "sp2"))))
	}

	@Test fun `ids are data, whatever is in them`() {
		exec("INSERT INTO track VALUES ('t', 'a\"b''c', 'local', NULL, NULL)")
		assertEquals(1, rows(FeedSql.heldByIsrc(listOf("a\"b'c", "]"))).size)
	}

	@Test fun `a page of items, and the owners of the playlists they came from`() {
		item("a", 5); item("b", 4)
		exec("UPDATE feed_item SET published_at = 2, origin_json = '{}' WHERE id = 'a'")
		assertEquals(mapOf("a" to 2, "b" to 4), rows(FeedSql.items(listOf("a", "b", "x"))).associate { it["id"] to it["at"] })
		exec("INSERT INTO playlist VALUES ('p', 'spotify', 'pl1', 'Leeados'), ('q', 'spotify', 'pl2', NULL), ('r', 'tidal', 'pl1', 'x')")
		assertEquals(listOf("Leeados"), rows(FeedSql.owners(listOf("pl1", "pl2"))).map { it["name"] })
	}

	@Test fun `a payload as the cloud producer writes it`() {
		val p = FeedJson.payload("""{"title":"Glass Rivers","artists":["Northfold","Kaske"],"artistIds":["sa1","catalog:a2"],"artistCatalogIds":["a1",null],"labelCatalogId":null,"label":"Northfold Records",
			"coverUrl":"https://img.test/c.jpg","releaseDate":"2026-10-23","albumType":"single","trackCount":2,"url":"https://open.spotify.com/album/al1","isrcResolved":true,"genre":null,
			"catalogId":"rel-1","handles":[{"provider":"spotify","id":"al1","url":"https://open.spotify.com/album/al1"}],"catalogNumber":null,"upc":null,
			"tracks":[{"sourceTrackId":"st1","catalogId":"r1","handles":[{"provider":"spotify","id":"st1","url":null}],"title":"Glass Rivers","artists":["Northfold"],"artistIds":["sa1"],
				"artistCatalogIds":["a1"],"durationSec":401.2,"trackNumber":1,"isrc":"GBAAA2600001","bpm":null,"keyCamelot":"8A","genre":null,"label":null,"releaseDate":"2026-10-23"}]}""")!!
		assertEquals(listOf("a1", null), p.artistCatalogIds)
		assertEquals(401.2, p.tracks!!.single().durationSec!!, 0.0)
		assertNull(p.genre)
		// Nulls where this build expects a list, and fields it has never heard of.
		assertNotNull(FeedJson.payload("""{"title":"x","artists":null,"handles":null,"somethingNew":{"a":1}}"""))
		assertNull(FeedJson.payload("not json"))
		assertEquals("Hot / Cold", FeedJson.origin("""{"kind":"playlist","id":"p","name":"Hot / Cold","catalogId":"c","owner":{"id":"u","name":null}}""")!!.name)
		assertTrue(FeedJson.origin(null) == null)
	}
}
