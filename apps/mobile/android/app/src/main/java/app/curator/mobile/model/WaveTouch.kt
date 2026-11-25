package app.curator.mobile.model

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max

/** A finger on a wave. */
data class Finger(val id: Long, val x: Float, val y: Float)

/**
 * What the fingers on a wave are doing, from the first down to the last up.
 *
 * One finger scrubs, once it has moved sideways past [slop] (until then it may
 * be a tap, or the first finger of two). A second finger makes it a pinch for
 * the rest of the gesture: a scrub already begun is called off, playback shows
 * where it is again, and the finger left when the other lifts moves nothing.
 * [yields]: a finger that goes up or down first is the page's scroll, not ours.
 */
class WaveTouch(private val slop: Float, private val yields: Boolean) {
	sealed interface Act {
		/** Nothing to do; [ours]: the moves are taken all the same. */
		data class Idle(val ours: Boolean) : Act
		data object Begin : Act
		data class Scrub(val x: Float, val dx: Float) : Act
		/** A pinch: the fingers are [factor] times as far apart as before. */
		data class Spread(val factor: Float) : Act
		data object CallOff : Act
		data object End : Act
	}

	private enum class Mode { PENDING, SCRUB, MULTI, GONE }

	private var mode = Mode.PENDING
	private var start: Finger? = null
	private var lastX = 0f
	private var pair: Pair<Long, Long>? = null
	private var apart = 0f

	/** The fingers now down; [taken]: something else took this move. */
	fun on(down: List<Finger>, taken: Boolean = false): Act {
		if (down.isEmpty()) return lift()
		if (mode == Mode.GONE) return Act.Idle(ours = false)
		if (down.size >= 2) return spread(down[0], down[1])
		val f = down[0]
		return when (mode) {
			Mode.SCRUB -> {
				val dx = f.x - lastX
				lastX = f.x
				if (dx == 0f) Act.Idle(ours = true) else Act.Scrub(f.x, dx)
			}
			Mode.MULTI -> {
				pair = null
				Act.Idle(ours = true)
			}
			else -> pending(f, taken)
		}
	}

	private fun pending(f: Finger, taken: Boolean): Act {
		val s = start ?: f.also { start = it }
		val dx = abs(f.x - s.x)
		val dy = abs(f.y - s.y)
		if (taken || (yields && dy > slop && dy > dx)) mode = Mode.GONE
		else if (dx > slop && (!yields || dx > dy)) {
			// From here, not from the first touch: the slop must not jump the wave.
			mode = Mode.SCRUB
			lastX = f.x
			return Act.Begin
		}
		return Act.Idle(ours = false)
	}

	private fun spread(a: Finger, b: Finger): Act {
		val scrubbing = mode == Mode.SCRUB
		mode = Mode.MULTI
		// Fingers almost touching: a hair's move would be a huge zoom.
		val d = max(hypot(a.x - b.x, a.y - b.y), slop * 2)
		val was = apart
		val same = pair == a.id to b.id
		pair = a.id to b.id
		apart = d
		return when {
			scrubbing -> Act.CallOff
			same && d != was -> Act.Spread(d / was)
			else -> Act.Idle(ours = true)
		}
	}

	private fun lift(): Act {
		val was = mode
		mode = Mode.GONE
		return if (was == Mode.SCRUB) Act.End else Act.Idle(ours = was == Mode.MULTI)
	}

	/** Taken away in the middle (or already over: nothing). */
	fun cancel(): Act {
		val was = mode
		mode = Mode.GONE
		return if (was == Mode.SCRUB) Act.CallOff else Act.Idle(ours = false)
	}
}
