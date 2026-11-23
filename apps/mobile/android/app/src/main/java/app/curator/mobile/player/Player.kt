package app.curator.mobile.player

import kotlinx.coroutines.flow.StateFlow

/**
 * What the Track view and the mini player drive. One interface over the
 * backends a track can play through (Spotify App Remote now; Tidal and the
 * library's own files later), so the views never know which one it is.
 *
 * Position is the player's, in seconds; while paused it is a cue point the
 * user can move (tap or drag on the waveform), as on a deck.
 */
interface Player {
	val state: StateFlow<PlayerState>

	/** Makes the track the current one, paused at its start (or keeps it if it already is). */
	fun load(track: PlayerTrack)
	fun play()
	fun pause()
	fun seek(sec: Double)
}

data class PlayerTrack(
	val trackId: String,
	val title: String,
	val artist: String,
	val coverUrl: String?,
	val durationSec: Double,
	/** Where it plays from: 'spotify', 'tidal', 'local'. */
	val source: String?,
	/** The provider's own id, when it has one (a Spotify track id). */
	val providerId: String?,
)

data class PlayerState(
	val track: PlayerTrack? = null,
	val playing: Boolean = false,
	val positionSec: Double = 0.0,
	/** Why the current track cannot play here, or null when it can. */
	val unavailable: String? = null,
)
