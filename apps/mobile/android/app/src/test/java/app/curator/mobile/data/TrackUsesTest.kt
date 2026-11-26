package app.curator.mobile.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.sql.Connection
import java.sql.DriverManager

/** The player's playlist and set lists (their lengths are its counts), against a real SQLite. */
class TrackUsesTest {
	private val db: Connection = DriverManager.getConnection("jdbc:sqlite::memory:").apply {
		createStatement().use { s ->
			for (sql in listOf(
				"CREATE TABLE playlist (id TEXT PRIMARY KEY, name TEXT, source TEXT, cover_url TEXT, parent_folder_id TEXT, is_hidden INTEGER, position INTEGER)",
				"CREATE TABLE playlist_track (playlist_id TEXT, track_id TEXT, order_key TEXT)",
				"CREATE TABLE play_session (id TEXT PRIMARY KEY, kind TEXT, name TEXT, started_at INTEGER)",
				"CREATE TABLE play_event (id TEXT PRIMARY KEY, session_id TEXT, track_id TEXT, played_at INTEGER)",
			)) s.execute(sql)
		}
	}

	@After fun close() = db.close()

	private fun exec(sql: String, vararg args: Any?) = db.prepareStatement(sql).use { st -> args.forEachIndexed { i, v -> st.setObject(i + 1, v) }; st.execute() }

	private fun ids(q: Sql): List<String> = db.prepareStatement(q.text).use { st ->
		q.args.forEachIndexed { i, v -> st.setObject(i + 1, v) }
		st.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString("id")) } }
	}

	init {
		for ((id, pos, hidden) in listOf(Triple("p1", 2, 0), Triple("p2", 1, 0), Triple("hid", 0, 1), Triple("other", 3, 0))) {
			exec("INSERT INTO playlist VALUES (?, ?, 'spotify', NULL, NULL, ?, ?)", id, id, hidden, pos)
		}
		// t is twice in p1: still one playlist.
		for ((p, t) in listOf("p1" to "t", "p1" to "t", "p2" to "t", "hid" to "t", "other" to "u")) exec("INSERT INTO playlist_track VALUES (?, ?, 'k')", p, t)
		exec("INSERT INTO play_session VALUES ('gig1', 'set', 'Friday', 100)")
		exec("INSERT INTO play_session VALUES ('gig2', 'set', NULL, 300)")
		exec("INSERT INTO play_session VALUES ('home', 'prep', NULL, 200)")
		exec("INSERT INTO play_session VALUES ('gig3', 'set', NULL, 400)")
		var n = 0
		for ((s, t) in listOf("gig1" to "t", "gig1" to "t", "gig2" to "t", "home" to "t", "gig3" to "u")) exec("INSERT INTO play_event VALUES (?, ?, ?, 0)", "e${n++}", s, t)
	}

	@Test
	fun `the playlists holding a track, each once, hidden ones left out`() {
		assertEquals(listOf("p2", "p1"), ids(TrackUses.playlists("t")))
		assertEquals(listOf("other"), ids(TrackUses.playlists("u")))
		assertEquals(emptyList<String>(), ids(TrackUses.playlists("none")))
	}

	@Test
	fun `the sets a track was played in, each once, newest first, prep sessions left out`() {
		assertEquals(listOf("gig2", "gig1"), ids(TrackUses.sets("t")))
		assertEquals(listOf("gig3"), ids(TrackUses.sets("u")))
	}

	@Test
	fun `a set counts all its plays`() {
		val q = TrackUses.sets("t")
		val counts = db.prepareStatement(q.text).use { st ->
			q.args.forEachIndexed { i, v -> st.setObject(i + 1, v) }
			st.executeQuery().use { rs -> buildMap { while (rs.next()) put(rs.getString("id"), rs.getInt("n")) } }
		}
		assertEquals(mapOf("gig2" to 1, "gig1" to 2), counts)
	}
}
