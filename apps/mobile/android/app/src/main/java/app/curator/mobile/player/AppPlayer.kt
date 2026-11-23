package app.curator.mobile.player

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import app.curator.mobile.BuildConfig
import com.spotify.android.appremote.api.ConnectionParams
import com.spotify.android.appremote.api.Connector
import com.spotify.android.appremote.api.SpotifyAppRemote
import com.spotify.android.appremote.api.error.CouldNotFindSpotifyApp
import com.spotify.android.appremote.api.error.NotLoggedInException
import com.spotify.android.appremote.api.error.UserNotAuthorizedException
import com.spotify.protocol.types.PlayerState as SpotifyState
import com.spotify.sdk.android.auth.AuthorizationClient
import com.spotify.sdk.android.auth.AuthorizationRequest
import com.spotify.sdk.android.auth.AuthorizationResponse
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

/**
 * The app's player. A Spotify track plays through the installed Spotify app
 * (App Remote: Spotify does the audio and its own notification; we drive it
 * and follow its state). Anything else loads and cues but does not play yet:
 * Tidal and the library's own files come later.
 *
 * App Remote reports the position only when the state changes (play, pause,
 * seek); between those the position here runs on the clock, so the playhead
 * moves smoothly.
 */
class AppPlayer : Player {
	private val _state = MutableStateFlow(PlayerState())
	override val state: StateFlow<PlayerState> = _state

	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
	private var remote: SpotifyAppRemote? = null
	private var connecting = false
	private var afterConnect: (() -> Unit)? = null
	private var activity = WeakReference<Activity>(null)
	private var launchAuth: ((Intent) -> Unit)? = null
	// The consent was asked in this run: a second "not authorized" is a refusal, not a first time.
	private var askedConsent = false
	private var ticker: Job? = null
	// The last position Spotify reported, and when (elapsed realtime ms).
	private var anchorSec = 0.0
	private var anchorAt = 0L

	/**
	 * The screen in front, and how it opens Spotify's consent screen. App
	 * Remote's own consent (showAuthView) is started by the Spotify app from
	 * the background, which Android 14+ blocks (seen on the Xperia, 2026-11-23:
	 * BAL_BLOCK); asked from our activity through the auth library, it shows.
	 */
	fun attach(a: Activity?, authorize: ((Intent) -> Unit)?) {
		activity = WeakReference(a)
		launchAuth = authorize
	}

	/** The consent screen's answer (MainActivity's result callback). */
	fun onAuthorized(resultCode: Int, data: Intent?) {
		val r = AuthorizationClient.getResponse(resultCode, data)
		when (r.type) {
			AuthorizationResponse.Type.TOKEN -> { val p = pending ?: return; pending = null; withRemote(p) }
			AuthorizationResponse.Type.ERROR -> { pending = null; fail("Spotify said no: ${r.error}") }
			else -> { pending = null; fail("Spotify wasn't connected") }
		}
	}

	// What to do once connected, while the consent screen is up.
	private var pending: ((SpotifyAppRemote) -> Unit)? = null

	override fun load(track: PlayerTrack) {
		if (_state.value.track?.trackId == track.trackId) return
		stopTicker()
		_state.value = PlayerState(track = track, unavailable = reasonFor(track))
	}

	override fun play() {
		val t = _state.value.track ?: return
		val reason = reasonFor(t)
		if (reason != null) { _state.value = _state.value.copy(playing = false, unavailable = reason); return }
		withRemote { r ->
			val uri = "spotify:track:${t.providerId}"
			val from = _state.value.positionSec
			r.playerApi.playerState.setResultCallback { s ->
				if (s.track?.uri == uri && s.isPaused) r.playerApi.resume()
				else r.playerApi.play(uri).setResultCallback { if (from > 1.0) r.playerApi.seekTo((from * 1000).toLong()) }
			}
		}
	}

	override fun pause() {
		remote?.playerApi?.pause()
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
		// Only the track Spotify is playing for us moves there; otherwise this is the cue point.
		if (s.playing) remote?.playerApi?.seekTo((at * 1000).toLong())
	}

	private fun reasonFor(t: PlayerTrack): String? = when {
		t.source != "spotify" -> "Not playable on this phone yet"
		t.providerId == null -> "No Spotify id for this track"
		BuildConfig.SPOTIFY_CLIENT_ID.isEmpty() -> "Spotify isn't configured in this build"
		else -> null
	}

	// Runs [then] with a connected App Remote, connecting first if needed.
	private fun withRemote(then: (SpotifyAppRemote) -> Unit) {
		remote?.takeIf { it.isConnected }?.let { then(it); return }
		afterConnect = { remote?.let(then) }
		if (connecting) return
		connecting = true
		val params = ConnectionParams.Builder(BuildConfig.SPOTIFY_CLIENT_ID)
			.setRedirectUri(BuildConfig.SPOTIFY_REDIRECT_URI)
			.showAuthView(false)
			.build()
		val context = activity.get() ?: return run { connecting = false; fail("Open Curator to connect Spotify") }
		SpotifyAppRemote.connect(context, params, object : Connector.ConnectionListener {
			override fun onConnected(r: SpotifyAppRemote) {
				connecting = false
				remote = r
				r.playerApi.subscribeToPlayerState().setEventCallback { follow(it) }
				afterConnect?.invoke()
				afterConnect = null
			}

			override fun onFailure(err: Throwable) {
				connecting = false
				val then = afterConnect
				afterConnect = null
				Log.w("curator-player", "Spotify did not connect", err)
				// First time on this phone: ask for the consent, then connect again.
				if (err is UserNotAuthorizedException && !askedConsent && then != null) {
					val ask = launchAuth ?: return fail("Open Curator to connect Spotify")
					askedConsent = true
					pending = { then() }
					val request = AuthorizationRequest.Builder(BuildConfig.SPOTIFY_CLIENT_ID, AuthorizationResponse.Type.TOKEN, BuildConfig.SPOTIFY_REDIRECT_URI)
						.setScopes(arrayOf("app-remote-control"))
						.build()
					ask(AuthorizationClient.createLoginActivityIntent(activity.get() ?: return fail("Open Curator to connect Spotify"), request))
					return
				}
				fail(
					when (err) {
						is CouldNotFindSpotifyApp -> "Install Spotify to play this track"
						is NotLoggedInException -> "Sign in to Spotify to play this track"
						is UserNotAuthorizedException -> "This Spotify account isn't allowed for Curator yet"
						else -> "Spotify didn't connect: ${err.message ?: err.javaClass.simpleName}"
					},
				)
			}
		})
	}

	private fun fail(reason: String) {
		_state.value = _state.value.copy(playing = false, unavailable = reason)
	}

	// Spotify's state, for the track it plays for us: playing or not, where.
	private fun follow(s: SpotifyState) {
		val ours = _state.value.track ?: return
		if (s.track?.uri != "spotify:track:${ours.providerId}") {
			// Something else plays in Spotify now (changed there): ours stopped.
			if (_state.value.playing) { stopTicker(); _state.value = _state.value.copy(playing = false) }
			return
		}
		anchorSec = s.playbackPosition / 1000.0
		anchorAt = SystemClock.elapsedRealtime()
		_state.value = _state.value.copy(playing = !s.isPaused, positionSec = anchorSec, unavailable = null)
		if (s.isPaused) stopTicker() else startTicker()
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
