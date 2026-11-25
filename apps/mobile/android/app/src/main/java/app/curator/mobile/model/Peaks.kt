package app.curator.mobile.model

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** One channel's three bands, a byte (0..255) per sample. */
class Bands(val low: ByteArray, val mid: ByteArray, val high: ByteArray)

/**
 * A track's waveform peaks: a `.cpk`'s detail block (apps/core analyzer/cpk.ts
 * has the format). Always the analyzer's own: the catalogue holds no
 * rekordbox waveforms, so low is the bass (the desktop swaps the bands of
 * those). [right] only in a stereo file, [rms] (the Golden skin's body) only
 * in a v3 one.
 */
class Peaks(val left: Bands, val right: Bands?, val rms: Bands?, val rightRms: Bands?, val samplesPerSec: Int) {
	val size: Int get() = left.low.size
	val seconds: Double get() = size.toDouble() / samplesPerSec

	/** What amplitudes are scaled by: the track's loudest bass, floored so a near-silent track doesn't draw as full-scale noise. */
	val norm: Float by lazy {
		var m = 64
		for (b in left.low) m = max(m, b.toInt() and 0xff)
		m.toFloat()
	}

	companion object {
		fun parse(b: ByteArray): Peaks? {
			if (b.size < 21 || String(b, 0, 8, Charsets.US_ASCII) != "CURPEAKS") return null
			fun u8(at: Int) = b[at].toInt() and 0xff
			fun u16(at: Int) = u8(at) or (u8(at + 1) shl 8)
			fun u32(at: Int) = u16(at).toLong() or (u16(at + 2).toLong() shl 16)
			val version = u8(8)
			if (version !in 1..3 || u8(9) != 3) return null
			// v1 is mono with a 20-byte header; v2 and v3 put the channel count at 10. v3 has rms beside each peak.
			val channels = if (version == 1) 1 else u8(10)
			if (channels != 1 && channels != 2) return null
			val header = if (version == 1) 20 else 21
			val at = if (version == 1) 10 else 11
			val sps = u16(at)
			val count = u32(at + 2)
			val metrics = if (version == 3) 2 else 1
			val stride = 3 * metrics * channels
			if (sps <= 0 || count <= 0 || header + count * stride > b.size) return null
			val n = count.toInt()
			fun group(channel: Int, metric: Int): Bands {
				val from = header + (channel * metrics + metric) * 3
				fun band(k: Int) = ByteArray(n) { b[from + it * stride + k] }
				return Bands(band(0), band(1), band(2))
			}
			return Peaks(
				left = group(0, 0),
				right = if (channels == 2) group(1, 0) else null,
				rms = if (metrics == 2) group(0, 1) else null,
				rightRms = if (metrics == 2 && channels == 2) group(1, 1) else null,
				samplesPerSec = sps,
			)
		}
	}
}

/** The bands over a run of columns, as mean amplitudes (0..255). */
class Columns(val bass: FloatArray, val mid: FloatArray, val treble: FloatArray)

/**
 * Columns [first] until first+[count] of a wave with [perColumn] samples to
 * each: column c covers samples [c·perColumn, (c+1)·perColumn) wherever it is
 * on screen, so a column's height never changes as the wave scrolls (the
 * desktop's bucket anchoring; columns pinned to the screen flicker). A
 * fractional sample counts by the part inside. Smoothing reads a column past
 * the run's edges: callers ask for a few more than they show.
 */
fun columns(b: Bands, first: Int, count: Int, perColumn: Double, skin: WaveSkin): Columns {
	val bass = FloatArray(count)
	val mid = FloatArray(count)
	val treble = FloatArray(count)
	val n = b.low.size
	for (i in 0 until count) {
		val from = max(0.0, (first + i) * perColumn)
		val to = min(n.toDouble(), (first + i + 1) * perColumn)
		if (to <= from) continue
		var l = 0.0
		var m = 0.0
		var h = 0.0
		for (j in floor(from).toInt() until min(n, ceil(to).toInt())) {
			val w = min(j + 1.0, to) - max(j.toDouble(), from)
			l += (b.low[j].toInt() and 0xff) * w
			m += (b.mid[j].toInt() and 0xff) * w
			h += (b.high[j].toInt() and 0xff) * w
		}
		bass[i] = (l / (to - from)).toFloat()
		mid[i] = (m / (to - from)).toFloat()
		treble[i] = (h / (to - from)).toFloat()
	}
	return Columns(smooth(bass, skin.smoothWindow), smooth(mid, skin.smoothWindow), smooth(treble, skin.smoothWindow))
}

// A symmetric box filter; a window of 1 leaves the transients as they are.
private fun smooth(a: FloatArray, window: Int): FloatArray {
	if (window < 2) return a
	val half = window / 2
	return FloatArray(a.size) { i ->
		val from = max(0, i - half)
		val to = min(a.size - 1, i + half)
		var sum = 0f
		for (j in from..to) sum += a[j]
		sum / (to - from + 1)
	}
}
