package app.curator.mobile.player

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import app.curator.mobile.model.StreamingService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The app's player. A streaming track plays from its own service, a local
 * file from the service picked in Settings, as the track its recording
 * claims there. Each service plays through its installed app, which a
 * [Backend] drives and follows: [SpotifyRemote]; Tidal has none yet
 * (StreamingService.playable). A track with nowhere to play loads and cues
 * but does not play.
 *
 * The services report the position only when their state changes (play,
 * pause, seek); between those the position here runs on the clock, so the
 * playhead moves smoothly.
 */
class AppPlayer : Player {
	private val _state = MutableStateFlow(PlayerState())
	override val state: StateFlow<PlayerState> = _state

	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
	private var activityRef = WeakReference<Activity>(null)
	private var ticker: Job? = null
	// The last position the service reported, and when (elapsed realtime ms).
	private var anchorSec = 0.0
	private var anchorAt = 0L

	private val host = object : BackendHost {
		override val current get() = _state.value.track
		override val activity get() = activityRef.get()

		override fun onState(playing: Boolean, positionSec: Double, atMs: Long, streamSec: Double?) {
			val t = _state.value.track ?: return
			anchorSec = positionSec
			anchorAt = atMs
			val now = positionSec + if (playing) (SystemClock.elapsedRealtime() - atMs) / 1000.0 else 0.0
			_state.value = _state.value.copy(
				playing = playing, positionSec = if (t.durationSec > 0) now.coerceAtMost(t.durationSec) else now,
				unavailable = null, note = noteFor(t, streamSec),
			)
			if (playing) startTicker() else stopTicker()
		}

		override fun onDisplaced() {
			if (_state.value.playing) { stopTicker(); _state.value = _state.value.copy(playing = false) }
		}

		override fun onFail(reason: String) {
			stopTicker()
			_state.value = _state.value.copy(playing = false, unavailable = reason)
		}
	}

	private val spotify = SpotifyRemote(host)

	private fun backend(s: StreamingService): Backend? = when (s) {
		StreamingService.SPOTIFY -> spotify
		StreamingService.TIDAL -> null
	}

	/** The screen in front, and how it opens Spotify's consent screen (null when it goes). */
	fun attach(a: Activity?, authorize: ((Intent) -> Unit)?) {
		activityRef = WeakReference(a)
		spotify.attach(authorize)
	}

	/** Spotify's consent screen's answer (MainActivity's result callback). */
	fun onAuthorized(resultCode: Int, data: Intent?) = spotify.onAuthorized(resultCode, data)

	override fun load(track: PlayerTrack) {
		// The same track again keeps its place, unless Settings moved where it plays from.
		val now = _state.value
		if (now.track?.trackId == track.trackId && now.track.service == track.service) return
		// The other service's app would play on under this one.
		if (now.playing && now.track != null && now.track.service != track.service) backend(now.track.service)?.pause()
		stopTicker()
		_state.value = PlayerState(track = track, unavailable = reasonFor(track), note = noteFor(track, null))
	}

	override fun play() {
		val t = _state.value.track ?: return
		val reason = reasonFor(t)
		if (reason != null) { _state.value = _state.value.copy(playing = false, unavailable = reason); return }
		backend(t.service)?.play(t, _state.value.positionSec)
	}

	override fun pause() {
		_state.value.track?.let { backend(it.service)?.pause() }
		stopTicker()
		_state.value = _state.value.copy(playing = false)
	}

	override fun seek(sec: Double) {
		val s = _state.value
		val d = s.track?.durationSec ?: 0.0
		val at = sec.coerceIn(0.0, if (d > 0) d else sec)
		anchorSec = at
		anchorAt = SystemClock.elapsedRealtime()
		_state.value = s.copy(positionSec = at)
		// Only the track the service is playing for us moves there; otherwise this is the cue point.
		if (s.playing && s.track != null) backend(s.track.service)?.seek(at)
	}

	private fun reasonFor(t: PlayerTrack): String? {
		val name = t.service.label
		return when {
			!t.service.playable -> "$name playback is coming soon"
			t.streamId == null -> if (t.source == t.service.id) "No $name id for this track" else "Not on $name, so not playable on this phone"
			else -> backend(t.service)?.unavailable()
		}
	}

	// A track the library has elsewhere says where it plays from. The cues,
	// grid and waveform are the file's analysis: when the stream's version
	// runs a different length (an edit, another master) they may not line up.
	private fun noteFor(t: PlayerTrack, streamSec: Double?): String? {
		if (t.source == t.service.id || t.streamId == null || !t.service.playable) return null
		val via = "Plays from ${t.service.label}"
		val diff = if (streamSec != null && t.durationSec > 0) streamSec - t.durationSec else 0.0
		if (abs(diff) < 2.0) return via
		val d = abs(diff).roundToInt()
		return "$via, whose version is ${d / 60}:${(d % 60).toString().padStart(2, '0')} ${if (diff > 0) "longer" else "shorter"}: cues may not line up"
	}

	private fun startTicker() {
		if (ticker?.isActive == true) return
		ticker = scope.launch {
			while (isActive) {
				val s = _state.value
				if (!s.playing) break
				val d = s.track?.durationSec ?: 0.0
				val now = anchorSec + (SystemClock.elapsedRealtime() - anchorAt) / 1000.0
				_state.value = s.copy(positionSec = if (d > 0) now.coerceAtMost(d) else now)
				delay(50)
			}
		}
	}

	private fun stopTicker() {
		ticker?.cancel()
		ticker = null
	}
}
