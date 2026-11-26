package app.curator.mobile.data

import app.curator.mobile.model.BpmBucket
import app.curator.mobile.model.ListView
import app.curator.mobile.model.Sort
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.sql.Connection
import java.sql.DriverManager

/** The list queries against a real SQLite holding the tables (and the index) they read. */
class ListQueryTest {
	private val db: Connection = DriverManager.getConnection("jdbc:sqlite::memory:").apply {
		createStatement().use { s ->
			for (sql in listOf(
				"""CREATE TABLE track (id TEXT PRIMARY KEY, title TEXT, overrides TEXT, bpm REAL, key_camelot TEXT, power REAL, duration INTEGER,
					added_at INTEGER, created_at INTEGER, remote_source TEXT, deleted_at INTEGER,
					title_ascii TEXT, artists_ascii TEXT, album_title_ascii TEXT, label_ascii TEXT, genre_ascii TEXT)""",
				"CREATE INDEX track_deleted_at_idx ON track(deleted_at)",
				"CREATE INDEX track_added_order_idx ON track(coalesce(added_at, created_at)) WHERE deleted_at IS NULL",
				"CREATE TABLE playlist_track (playlist_id TEXT, track_id TEXT, order_key TEXT)",
				"CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT, kind TEXT)",
				"CREATE TABLE track_tag (track_id TEXT, tag_id TEXT, added_at INTEGER)",
				"CREATE TABLE track_artist (track_id TEXT, artist_id TEXT)",
			)) s.execute(sql)
		}
	}

	@After fun close() = db.close()

	private fun track(id: String, bpm: Double? = null, key: String? = null, power: Double? = null, owned: Boolean = false, added: Long? = null, title: String = id, artists: String = "", overrides: String? = null, deleted: Boolean = false) {
		// created_at is NOT NULL in the schema: a track without added_at is added when created.
		db.prepareStatement("INSERT INTO track VALUES (?, ?, ?, ?, ?, ?, 200, ?, 0, ?, ?, ?, ?, '', '', '')").use { st ->
			listOf(id, title, overrides, bpm, key, power, added, if (owned) "local" else "spotify", if (deleted) 1L else null, title.lowercase(), artists)
				.forEachIndexed { i, v -> st.setObject(i + 1, v) }
			st.execute()
		}
	}

	private fun exec(sql: String, vararg args: Any?) = db.prepareStatement(sql).use { st -> args.forEachIndexed { i, v -> st.setObject(i + 1, v) }; st.execute() }

	private fun ids(q: Sql): List<String> = db.prepareStatement(q.text).use { st ->
		q.args.forEachIndexed { i, v -> st.setObject(i + 1, v) }
		st.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString("id")) } }
	}

	private val playlist = ListScope.Playlist("pl")
	private fun ids(v: ListView, scope: ListScope = playlist, search: String = "") = ids(ListQuery(scope, v, search).ids())

	init {
		track("a", bpm = 118.0, key = "8A", power = 0.6, owned = true, added = 3, title = "Beta")
		track("b", bpm = 122.0, key = "2B", power = 0.2, added = 1, title = "alpha", artists = "ben bohmer")
		track("c", bpm = 126.0, key = "2A", owned = true, added = 2, title = "Gamma")
		track("d", power = 0.9, title = "Delta")
		track("gone", bpm = 120.0, title = "Gone", deleted = true)
		for ((i, id) in listOf("a", "b", "gone", "c", "d").withIndex()) exec("INSERT INTO playlist_track VALUES ('pl', ?, ?)", id, "k$i")
		for ((id, name) in listOf("t2" to "p2", "t3" to "p3", "tb" to "build", "tw" to "warm")) exec("INSERT INTO tag VALUES (?, ?, 'user')", id, name)
		for ((t, g) in listOf("a" to "t2", "b" to "t3", "b" to "tb", "c" to "tw")) exec("INSERT INTO track_tag VALUES (?, ?, 0)", t, g)
	}

	@Test fun `custom keeps the list's own order, without the deleted`() {
		assertEquals(listOf("a", "b", "c", "d"), ids(ListView()))
		assertEquals(listOf("d", "c", "b", "a"), ids(ListView(dir = -1)))
	}

	@Test fun `each sort, with missing values last in both directions`() {
		assertEquals(listOf("b", "a", "d", "c"), ids(ListView(sort = Sort.ENERGY)))
		assertEquals(listOf("d", "a", "b", "c"), ids(ListView(sort = Sort.ENERGY, dir = -1)))
		assertEquals(listOf("a", "b", "c", "d"), ids(ListView(sort = Sort.BPM)))
		assertEquals(listOf("c", "b", "a", "d"), ids(ListView(sort = Sort.BPM, dir = -1)))
		assertEquals(listOf("c", "b", "a", "d"), ids(ListView(sort = Sort.KEY)))
		assertEquals(listOf("d", "b", "c", "a"), ids(ListView(sort = Sort.ADDED)))
		assertEquals(listOf("b", "a", "d", "c"), ids(ListView(sort = Sort.TITLE)))
	}

	@Test fun `ties break on the key, overrides win`() {
		exec("UPDATE track SET bpm = 122, key_camelot = '9A' WHERE id = 'a'")
		exec("""UPDATE track SET overrides = '{"keyCamelot":"1B"}' WHERE id = 'c'""")
		exec("UPDATE track SET bpm = 122 WHERE id = 'c'")
		assertEquals(listOf("c", "b", "a", "d"), ids(ListView(sort = Sort.BPM)))
	}

	@Test fun `tag filter matches every selected tag, bpm buckets, owned only`() {
		assertEquals(listOf("b"), ids(ListView(tags = setOf("build"))))
		assertEquals(listOf("b"), ids(ListView(tags = setOf("p3", "build"))))
		assertEquals(emptyList<String>(), ids(ListView(tags = setOf("p2", "build"))))
		assertEquals(listOf("a"), ids(ListView(bpm = BpmBucket.LOW)))
		assertEquals(listOf("b"), ids(ListView(bpm = BpmBucket.MID)))
		assertEquals(listOf("c"), ids(ListView(bpm = BpmBucket.HIGH)))
		assertEquals(listOf("a", "c"), ids(ListView(ownedOnly = true)))
	}

	@Test fun `search folds the query as the columns are folded, every word anywhere`() {
		assertEquals(listOf("b"), ids(ListView(), search = "Böhmer ALPHA"))
		assertEquals(emptyList<String>(), ids(ListView(), search = "bohmer beta"))
		assertEquals(listOf("a", "b", "c", "d"), ids(ListView(), search = "  "))
	}

	@Test fun `library scope is every track, newest added first, or one source's`() {
		assertEquals(listOf("a", "c", "b", "d"), ids(ListView(), ListScope.Library(null)))
		assertEquals(listOf("a", "c"), ids(ListView(), ListScope.Library("local")))
	}

	@Test fun `a tag's own order is newest tagging first`() {
		exec("UPDATE track_tag SET added_at = 5 WHERE track_id = 'a' AND tag_id = 't2'")
		exec("INSERT INTO track_tag VALUES ('c', 't2', 9), ('gone', 't2', 10)")
		assertEquals(listOf("c", "a"), ids(ListView(), ListScope.Tag("t2")))
		assertEquals(listOf("a", "c"), ids(ListView(sort = Sort.ENERGY), ListScope.Tag("t2")))
	}

	@Test fun `the first page alone, the library's through its added-order index`() {
		assertEquals(listOf("a", "b"), ids(ListQuery(playlist, ListView()).ids(limit = 2)))
		assertEquals(listOf("b", "a"), ids(ListQuery(playlist, ListView(sort = Sort.ENERGY)).ids(limit = 2)))
		val library = ListQuery(ListScope.Library(null), ListView()).ids(limit = 3)
		assertTrue("INDEXED BY track_added_order_idx" in library.text)
		assertEquals(listOf("a", "c", "b"), ids(library))
		assertEquals(listOf("d", "b"), ids(ListQuery(ListScope.Library(null), ListView(sort = Sort.ADDED)).ids(limit = 2)))
		assertEquals(listOf("c"), ids(ListQuery(ListScope.Library("local"), ListView(dir = -1)).ids(limit = 1)))
	}

	@Test fun `totals and tag counts are the scope's, before the view`() {
		val q = ListQuery(playlist, ListView(ownedOnly = true))
		db.prepareStatement(q.totals().text).use { st ->
			q.totals().args.forEachIndexed { i, v -> st.setObject(i + 1, v) }
			st.executeQuery().use { rs -> rs.next(); assertEquals(4, rs.getInt("n")); assertEquals(800L, rs.getLong("secs")) }
		}
		val names = db.prepareStatement(q.tagCounts().text).use { st ->
			q.tagCounts().args.forEachIndexed { i, v -> st.setObject(i + 1, v) }
			st.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString("name")) } }
		}
		assertEquals(setOf("p2", "p3", "build", "warm"), names.toSet())
	}

	@Test fun `a label's tracks, by the name as the tracks spell it, overrides first`() {
		exec("ALTER TABLE track ADD COLUMN label TEXT")
		exec("UPDATE track SET label = 'Anjunadeep' WHERE id IN ('a', 'gone')")
		exec("UPDATE track SET label = 'anjunadeep' WHERE id = 'b'")
		exec("""UPDATE track SET label = 'Other', overrides = '{"label":"Anjunadeep"}' WHERE id = 'c'""")
		assertEquals(listOf("a", "c", "b"), ids(ListView(), ListScope.Label("Anjunadeep")))
	}

	@Test fun `a set's tracks as played`() {
		exec("CREATE TABLE play_event (session_id TEXT, track_id TEXT, played_at INTEGER)")
		exec("INSERT INTO play_event VALUES ('s', 'c', 1), ('s', 'a', 2), ('s', 'gone', 3), ('x', 'b', 0)")
		assertEquals(listOf("c", "a"), ids(ListView(), ListScope.Set("s")))
	}

	@Test fun `similar is near BPM, a related key, near power and brightness, nearest BPM first`() {
		exec("ALTER TABLE track ADD COLUMN brightness REAL")
		exec("UPDATE track SET bpm = 124, power = 0.5 WHERE id = 'c'")
		exec("UPDATE track SET bpm = 121, power = 0.4, key_camelot = '1B' WHERE id = 'a'")
		exec("INSERT INTO track (id, title, bpm, key_camelot, power, created_at, remote_source) VALUES ('far', 'Far', 122, '2B', 0.9, 0, 'spotify')")
		exec("INSERT INTO track (id, title, bpm, key_camelot, power, created_at, remote_source) VALUES ('clash', 'Clash', 122, '6A', 0.2, 0, 'spotify')")
		// b: 122 BPM, 2B, power 0.2 (no brightness: not compared).
		val similar = ListScope.Similar("b", app.curator.mobile.model.relatedKeys("2B"))
		assertEquals(listOf("a", "c"), ids(ListView(), similar))
		// A brightness on the seed rules out the tracks without one near it.
		exec("UPDATE track SET brightness = 2.0 WHERE id = 'b'")
		exec("UPDATE track SET brightness = 2.4 WHERE id = 'c'")
		assertEquals(listOf("c"), ids(ListView(), similar))
		// A key that isn't Camelot: no key condition.
		exec("UPDATE track SET brightness = 2.1 WHERE id = 'clash'")
		assertEquals(listOf("clash", "c"), ids(ListView(), ListScope.Similar("b", emptyList())))
	}
}
