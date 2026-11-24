package app.curator.mobile.player

import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.util.Log
import app.curator.mobile.model.StreamingService
import java.text.Normalizer

/**
 * Tidal through the installed TIDAL app, as Spotify goes through Spotify's:
 * TIDAL plays the full track on the user's own subscription, and we steer
 * and follow it through its media session. TIDAL's own Player SDK would
 * play inside Curator, but gives a third-party app 30-second previews until
 * TIDAL grants it production access (decided 2026-11-24).
 *
 * Seeing another app's media session takes Notification access
 * ([MediaAccessService]); the first play asks for it and plays once it is
 * given. A track starts through TIDAL's own share link (tidal.com/browse/
 * track/<id>), which brings TIDAL to the front; once its session shows the
 * track, we seek to the cue point and press play if TIDAL only opened it.
 * TIDAL publishes no deep-link or session contract, so the track is
 * recognised from the session's metadata ([sameTrack]) rather than assumed.
 */
internal class TidalRemote(private val context: Context, private val host: BackendHost) : Backend {
	private val sessions = context.getSystemService(MediaSessionManager::class.java)
	private val access = ComponentName(context, MediaAccessService::class.java)
	private val main = Handler(Looper.getMainLooper())
	private var watching = false
	private var controller: MediaController? = null

	// The track asked of TIDAL, until its session shows it: meanwhile the
	// session's other track is the one before, not a displacement.
	private class Starting(val streamId: String, val fromSec: Double)
	private var starting: Starting? = null
	// The play asked while Curator waited on Notification access: run when the user comes back with it.
	private var afterAccess: (() -> Unit)? = null

	override fun unavailable(): String? = if (!installed()) "Install TIDAL to play this track" else null

	override fun play(t: PlayerTrack, fromSec: Double) {
		if (!hasAccess()) return askAccess { play(t, fromSec) }
		watch()
		val c = controller
		if (c != null && sameTrack(c.metadata, t)) {
			c.transportControls.seekTo(ms(fromSec))
			c.transportControls.play()
			return
		}
		val id = t.streamId ?: return
		val a = host.activity ?: return host.onFail("Open Curator to play on TIDAL")
		starting = Starting(id, fromSec)
		main.removeCallbacks(gaveUp)
		main.postDelayed(gaveUp, START_TIMEOUT_MS)
		try {
			a.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://tidal.com/browse/track/$id")).setPackage(TIDAL))
		} catch (e: ActivityNotFoundException) {
			starting = null
			host.onFail("Install TIDAL to play this track")
		}
	}

	override fun pause() {
		starting = null
		controller?.transportControls?.pause()
	}

	override fun seek(sec: Double) {
		controller?.transportControls?.seekTo(ms(sec))
	}

	/** Back in front (MainActivity.onStart): a play that waited on Notification access goes ahead once it's given. */
	fun onResume() {
		val then = afterAccess ?: return
		if (!hasAccess()) return
		afterAccess = null
		then()
	}

	private fun installed() = context.packageManager.getLaunchIntentForPackage(TIDAL) != null

	private fun hasAccess() = context.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(access)

	private fun askAccess(then: () -> Unit) {
		val a = host.activity ?: return host.onFail("Open Curator to play on TIDAL")
		afterAccess = then
		host.onFail("Allow Curator's notification access: it is how Curator follows TIDAL's player")
		val detail = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
			.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, access.flattenToString())
		try {
			a.startActivity(detail)
		} catch (e: ActivityNotFoundException) {
			// Some builds have no per-app page: the list of every listener.
			a.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
		}
	}

	// Follows TIDAL's session from the first play on: it appears when TIDAL
	// first plays in its process, and goes when TIDAL is closed.
	private fun watch() {
		if (!watching) {
			sessions.addOnActiveSessionsChangedListener({ pick(it) }, access, main)
			watching = true
		}
		pick(sessions.getActiveSessions(access))
	}

	private fun pick(list: List<MediaController>?) {
		val next = list?.firstOrNull { it.packageName == TIDAL }
		if (next?.sessionToken == controller?.sessionToken) return
		controller?.unregisterCallback(callback)
		controller = next
		next?.registerCallback(callback, main)
		evaluate()
	}

	private val callback = object : MediaController.Callback() {
		override fun onPlaybackStateChanged(state: PlaybackState?) = evaluate()
		override fun onMetadataChanged(metadata: MediaMetadata?) = evaluate()
		override fun onSessionDestroyed() {
			controller?.unregisterCallback(this)
			controller = null
			if (host.current?.service == StreamingService.TIDAL) host.onDisplaced()
		}
	}

	private val gaveUp = Runnable {
		if (starting == null) return@Runnable
		starting = null
		// Still followed: pressing play there shows here.
		host.onFail("TIDAL didn't start it: press play in TIDAL")
	}

	// TIDAL's state, for the track it plays for us.
	private fun evaluate() {
		val t = host.current?.takeIf { it.service == StreamingService.TIDAL } ?: return
		val c = controller ?: return
		if (!sameTrack(c.metadata, t)) {
			// The track before ours, while TIDAL opens ours; else something else plays there now.
			if (starting == null) host.onDisplaced()
			return
		}
		val state = c.playbackState
		starting?.let { s ->
			starting = null
			main.removeCallbacks(gaveUp)
			if (s.fromSec > 1.0) c.transportControls.seekTo(ms(s.fromSec))
			if (state?.state != PlaybackState.STATE_PLAYING) c.transportControls.play()
		}
		if (state == null) return
		val playing = state.state == PlaybackState.STATE_PLAYING || state.state == PlaybackState.STATE_BUFFERING
		val at = state.lastPositionUpdateTime.takeIf { it > 0 } ?: SystemClock.elapsedRealtime()
		val length = c.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION)?.takeIf { it > 0 }?.let { it / 1000.0 }
		host.onState(playing, state.position.coerceAtLeast(0) / 1000.0, at, length)
	}

	private fun sameTrack(md: MediaMetadata?, t: PlayerTrack): Boolean {
		if (md == null) return false
		val streamId = starting?.streamId ?: t.streamId ?: return false
		return sameTrack(md.getString(MediaMetadata.METADATA_KEY_MEDIA_ID), md.getString(MediaMetadata.METADATA_KEY_TITLE), streamId, t.title)
			.also { if (!it) Log.d("curator-player", "TIDAL plays ${md.getString(MediaMetadata.METADATA_KEY_MEDIA_ID)} / ${md.getString(MediaMetadata.METADATA_KEY_TITLE)}, not $streamId") }
	}

	private fun ms(sec: Double) = (sec * 1000).toLong()

	companion object {
		const val TIDAL = "com.aspiro.tidal"
		private const val START_TIMEOUT_MS = 10_000L

		/**
		 * Whether TIDAL's session item is our track: its media id names our id
		 * as a whole number, else (an id that isn't the track's) its title
		 * starts with ours, folded, so "Strobe" is "Strobe (Original Mix)".
		 */
		internal fun sameTrack(mediaId: String?, title: String?, streamId: String, ourTitle: String): Boolean {
			if (mediaId != null && Regex("\\d+").findAll(mediaId).any { it.value == streamId }) return true
			val ours = fold(ourTitle)
			return title != null && ours.isNotEmpty() && fold(title).startsWith(ours)
		}

		private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).lowercase().filter { it.isLetterOrDigit() }
	}
}

/**
 * Declared only so the user can grant Notification access, which is what
 * lets another app's media session be seen (MediaSessionManager.
 * getActiveSessions): TIDAL's, for [TidalRemote]. It reads no notifications.
 */
class MediaAccessService : NotificationListenerService()
