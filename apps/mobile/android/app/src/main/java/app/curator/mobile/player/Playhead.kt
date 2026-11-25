package app.curator.mobile.player

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max

/**
 * Where playback is, at any moment: a service reports its position now and
 * then, and between reports this runs on the clock (elapsed realtime, ns).
 *
 * A report a little off from where the clock has got to (the service's own
 * latency) is eased into, always forwards, so the wave never twitches; a big
 * difference is a real move and lands at once. Just after a seek (or a start)
 * a report far from its target is an older one still in flight: the seek
 * stands. Moved while paused, it is a cue point the service doesn't know of:
 * it stands until the service plays.
 */
class Playhead {
	private var sec = 0.0
	private var at = 0L
	private var running = false
	// How far the shown position was from the report at [at]; it fades.
	private var lead = 0.0
	private var seekAt: Long? = null
	private var cued = false

	fun position(now: Long): Double {
		if (!running) return sec
		val t = max(0.0, (now - at) / 1e9)
		return max(0.0, sec + t + lead * exp(-t / EASE_SEC))
	}

	/** Another track: at its start. */
	fun reset(now: Long) {
		stop(now)
		sec = 0.0
		seekAt = null
		cued = false
	}

	/** The user moved it; [service]: the service playing it was told to as well. */
	fun seek(to: Double, now: Long, service: Boolean) {
		sec = to
		at = now
		lead = 0.0
		seekAt = if (service) now else null
		cued = !service
	}

	/** The service was told to play from here. */
	fun starting(now: Long) {
		seekAt = now
	}

	fun stop(now: Long) {
		sec = position(now)
		at = now
		running = false
		lead = 0.0
	}

	/** The service was at [to] at [asOf]. */
	fun report(to: Double, asOf: Long, playing: Boolean, now: Long) {
		val shown = position(now)
		if (playing) cued = false
		else if (cued) return stop(now)
		val said = to + if (playing) (now - asOf) / 1e9 else 0.0
		val off = shown - said
		val stale = seekAt?.let { now - it < SEEK_FENCE_NS } == true && abs(off) > SEEK_TOLERANCE_SEC
		lead = if (!stale && playing && running && abs(off) < EASE_MAX_SEC) off else 0.0
		sec = if (stale) shown else said
		at = now
		running = playing
	}

	companion object {
		// EASE_MAX under EASE: the ease back is slower than the clock, so the head keeps going forwards.
		private const val EASE_MAX_SEC = 0.5
		private const val EASE_SEC = 0.6
		private const val SEEK_FENCE_NS = 1_500_000_000L
		private const val SEEK_TOLERANCE_SEC = 1.0
	}
}
