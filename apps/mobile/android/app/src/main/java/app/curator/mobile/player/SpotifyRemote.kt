package app.curator.mobile.player

import android.content.Intent
import android.os.SystemClock
import android.util.Log
import app.curator.mobile.BuildConfig
import app.curator.mobile.model.StreamingService
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

/**
 * Spotify through the installed Spotify app (App Remote): Spotify does the
 * audio and its own notification; we drive it and follow its state. App
 * Remote reports the position only when the state changes (play, pause,
 * seek), so AppPlayer runs it on the clock in between.
 */
internal class SpotifyRemote(private val host: BackendHost) : Backend {
	private var remote: SpotifyAppRemote? = null
	private var connecting = false
	private var afterConnect: (() -> Unit)? = null
	private var launchAuth: ((Intent) -> Unit)? = null
	// The consent was asked in this run: a second "not authorized" is a refusal, not a first time.
	private var askedConsent = false
	// What to do once connected, while the consent screen is up.
	private var pending: ((SpotifyAppRemote) -> Unit)? = null

	/**
	 * How the screen in front opens Spotify's consent screen. App Remote's own
	 * consent (showAuthView) is started by the Spotify app from the
	 * background, which Android 14+ blocks (seen on the Xperia, 2026-11-23:
	 * BAL_BLOCK); asked from our activity through the auth library, it shows.
	 */
	fun attach(authorize: ((Intent) -> Unit)?) {
		launchAuth = authorize
	}

	/** The consent screen's answer (MainActivity's result callback). */
	fun onAuthorized(resultCode: Int, data: Intent?) {
		val r = AuthorizationClient.getResponse(resultCode, data)
		when (r.type) {
			AuthorizationResponse.Type.TOKEN -> { val p = pending ?: return; pending = null; withRemote(p) }
			AuthorizationResponse.Type.ERROR -> { pending = null; host.onFail("Spotify said no: ${r.error}") }
			else -> { pending = null; host.onFail("Spotify wasn't connected") }
		}
	}

	override fun unavailable(): String? = if (BuildConfig.SPOTIFY_CLIENT_ID.isEmpty()) "Spotify isn't configured in this build" else null

	override fun play(t: PlayerTrack, fromSec: Double) {
		withRemote { r ->
			val uri = "spotify:track:${t.streamId}"
			r.playerApi.playerState.setResultCallback { s ->
				if (s.track?.uri == uri && s.isPaused) r.playerApi.resume()
				else r.playerApi.play(uri).setResultCallback { if (fromSec > 1.0) r.playerApi.seekTo((fromSec * 1000).toLong()) }
			}
		}
	}

	override fun pause() {
		remote?.playerApi?.pause()
	}

	override fun seek(sec: Double) {
		remote?.playerApi?.seekTo((sec * 1000).toLong())
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
		val context = host.activity ?: return run { connecting = false; host.onFail("Open Curator to connect Spotify") }
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
					val ask = launchAuth ?: return host.onFail("Open Curator to connect Spotify")
					askedConsent = true
					pending = { then() }
					val request = AuthorizationRequest.Builder(BuildConfig.SPOTIFY_CLIENT_ID, AuthorizationResponse.Type.TOKEN, BuildConfig.SPOTIFY_REDIRECT_URI)
						.setScopes(arrayOf("app-remote-control"))
						.build()
					ask(AuthorizationClient.createLoginActivityIntent(host.activity ?: return host.onFail("Open Curator to connect Spotify"), request))
					return
				}
				host.onFail(
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

	// Spotify's state, for the track it plays for us: playing or not, where.
	private fun follow(s: SpotifyState) {
		// A track playing through Tidal: Spotify's state isn't about it.
		val ours = host.current?.takeIf { it.service == StreamingService.SPOTIFY } ?: return
		if (s.track?.uri != "spotify:track:${ours.streamId}") {
			// Something else plays in Spotify now (changed there): ours stopped.
			host.onDisplaced()
			return
		}
		host.onState(!s.isPaused, s.playbackPosition / 1000.0, SystemClock.elapsedRealtime(), s.track.duration / 1000.0)
	}
}
