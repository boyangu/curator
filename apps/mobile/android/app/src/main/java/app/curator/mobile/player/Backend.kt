package app.curator.mobile.player

import android.app.Activity

/**
 * One service's player, as AppPlayer drives it: the service's own app does
 * the audio, and the backend starts, steers and follows it. It follows only
 * the track loaded in AppPlayer ([BackendHost.current]), and only while
 * that track plays through it.
 */
internal interface Backend {
	/** Why a track can't play through it on this phone (not configured, the app not installed), or null. */
	fun unavailable(): String?
	/** Plays [t] from [fromSec]: resumes it (moved there first, if it stopped elsewhere) when the service's app has it already, else starts it there. */
	fun play(t: PlayerTrack, fromSec: Double)
	fun pause()
	fun seek(sec: Double)
}

/** AppPlayer, as its backends see it. */
internal interface BackendHost {
	val current: PlayerTrack?
	/** The screen in front, for what has to be asked from it (consent, a settings page, opening the app). */
	val activity: Activity?
	/** The service's state for [current]: at [positionSec] as of [atMs] (elapsed realtime). [streamSec]: the stream's length, when known. */
	fun onState(playing: Boolean, positionSec: Double, atMs: Long, streamSec: Double?)
	/** The service's app plays something else now: ours stopped. */
	fun onDisplaced()
	fun onFail(reason: String)
}
