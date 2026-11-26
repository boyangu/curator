package app.curator.mobile.data

/** A set a track was played in: its play-history session. */
data class SetSummary(val id: String, val name: String?, val startedAt: Long, val tracks: Int)

/**
 * Where a track is used, for the player's "In 3 playlists" and "Played in 2
 * sets": the counts are these lists' lengths, so a row never says a number
 * its list doesn't hold. A set is a play_session the history calls one (kind
 * 'set': played out, as against 'prep', going through tracks at home; the
 * desktop's rekordbox history import tells them apart).
 */
object TrackUses {
	fun playlists(trackId: String) = Sql(
		"""
		SELECT p.id, p.name, p.source, p.cover_url, p.parent_folder_id FROM playlist p
		WHERE p.id IN (SELECT playlist_id FROM playlist_track WHERE track_id = ?) AND coalesce(p.is_hidden, 0) = 0
		ORDER BY coalesce(p.position, 2147483647), p.name COLLATE NOCASE
		""".trimIndent(),
		arrayOf(trackId),
	)

	fun sets(trackId: String) = Sql(
		"""
		SELECT s.id, s.name, s.started_at, (SELECT count(*) FROM play_event e WHERE e.session_id = s.id) AS n FROM play_session s
		WHERE s.kind = 'set' AND s.id IN (SELECT session_id FROM play_event WHERE track_id = ?)
		ORDER BY s.started_at DESC
		""".trimIndent(),
		arrayOf(trackId),
	)
}
