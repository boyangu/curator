package app.curator.mobile.model

import kotlin.math.abs

/** What of the beat grid the big wave shows: each a switch in Settings, per phone. */
data class GridShow(val beats: Boolean = true, val bars: Boolean = true)

/** A beat on the grid; [bar]: its bar's number (1-based) when it starts one. */
data class GridMark(val sec: Float, val bar: Int?)

/**
 * The grid's beats from [from] to [to] seconds, each marked as a bar's first
 * or not. A bar starts where the downbeats say (they know a pickup); a beat
 * and a downbeat a hair apart are one (the two can come from different
 * analyses). With no downbeats, every fourth beat, as the desktop does.
 */
fun gridMarks(beats: FloatArray, downbeats: FloatArray, from: Double, to: Double): List<GridMark> {
	val out = ArrayList<GridMark>()
	var i = firstFrom(beats, from)
	var d = firstFrom(downbeats, from - TOLERANCE)
	while (i < beats.size && beats[i] <= to) {
		val b = beats[i]
		while (d < downbeats.size && downbeats[d] < b - TOLERANCE) d++
		val bar = when {
			downbeats.isEmpty() -> if (i % 4 == 0) i / 4 + 1 else null
			d < downbeats.size && abs(downbeats[d] - b) <= TOLERANCE -> d + 1
			else -> null
		}
		out += GridMark(b, bar)
		i++
	}
	return out
}

private const val TOLERANCE = 0.02f

/** The index of the first time at or after [t] (they are sorted). */
private fun firstFrom(a: FloatArray, t: Double): Int = java.util.Arrays.binarySearch(a, t.toFloat()).let { if (it < 0) -it - 1 else it }
