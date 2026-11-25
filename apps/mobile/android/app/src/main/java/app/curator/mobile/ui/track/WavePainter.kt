package app.curator.mobile.ui.track

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import app.curator.mobile.model.Bands
import app.curator.mobile.model.Columns
import app.curator.mobile.model.ENVELOPE_BODY
import app.curator.mobile.model.MapModel
import app.curator.mobile.model.Peaks
import app.curator.mobile.model.WaveModel
import app.curator.mobile.model.WaveSkin
import app.curator.mobile.model.columns
import app.curator.mobile.model.spectrumColor
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

// The desktop's two painters (renderer/renderers/canvasWaveform.ts and
// svgWaveform.ts) on an Android canvas, off any thread. A column is one dp, as
// theirs is one CSS pixel.

// The bars' share of the height, and the gap under them.
private const val BAR_H = 0.94f
private const val FLOOR_PAD = 0.02f

// Columns past each edge: a smoothed curve only runs true a couple of columns
// in from its ends, so a tile's edge must not be one.
private const val EDGE = 4

private class Bars(height: Int) {
	val barH = BAR_H * height
	val floor = height * (1 - FLOOR_PAD)
	// A whole pixel: the two halves meet without a seam.
	val center = (floor - barH / 2).roundToInt().toFloat()
}

private fun fill(color: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

private fun darken(color: Int, by: Float): Int {
	fun c(shift: Int) = ((color ushr shift and 0xff) * by).roundToInt()
	return (0xff shl 24) or (c(16) shl 16) or (c(8) shl 8) or c(0)
}

/**
 * The big wave from pixel [origin] of the whole wave's width (at [pxPerSec]),
 * [width] pixels of it: what it draws at a pixel of the wave doesn't depend on
 * where the piece starts, so pieces join without a seam.
 */
fun paintWave(canvas: Canvas, peaks: Peaks, skin: WaveSkin, pxPerSec: Double, origin: Int, width: Int, height: Int, columnPx: Float) {
	val perColumn = peaks.samplesPerSec * columnPx / pxPerSec
	val first = floor(origin / columnPx).toInt() - EDGE
	val n = ceil(width / columnPx).toInt() + 2 * EDGE + 1
	fun cols(b: Bands) = columns(b, first, n, perColumn, skin)
	val left = cols(peaks.left)
	val right = peaks.right?.let { cols(it) } ?: left
	val stereo = peaks.right != null
	val bars = Bars(height)
	val norm = peaks.norm
	fun level(v: Float) = min(1f, v / norm).pow(skin.gamma)
	fun h(v: Float, gain: Float) = level(v) * bars.barH * gain
	val (gB, gM, gT) = skin.gains
	fun x(i: Int) = (first + i) * columnPx - origin
	// A column's own pixels, whole ones: the ones it has in the wave, so they don't move between its neighbours.
	fun edge(i: Int) = ((first + i) * columnPx).roundToInt() - origin

	when (skin.model) {
		WaveModel.OVERLAP -> {
			// Mirrored on the centre: left channel above, right below (one channel: the same both ways).
			val smooth = skin.smoothWindow > 1
			fun heights(of: (Columns) -> FloatArray, gain: Float): Pair<FloatArray, FloatArray> {
				val l = of(left); val r = of(right)
				return FloatArray(n) { h(l[it], gain) } to FloatArray(n) { h(r[it], gain) }
			}
			fun band(hs: Pair<FloatArray, FloatArray>, color: Int) {
				val path = Path()
				path.moveTo(x(0), bars.center - hs.first[0] / 2)
				path.curve(n, forward = true, smooth, ::x) { bars.center - hs.first[it] / 2 }
				path.curve(n, forward = false, smooth, ::x) { bars.center + hs.second[it] / 2 }
				path.close()
				canvas.drawPath(path, fill(color))
			}
			val bass = heights({ it.bass }, gB)
			val mid = heights({ it.mid }, gM)
			band(bass, skin.bass)
			band(mid, skin.mid)
			skin.blend?.let { c ->
				band(FloatArray(n) { min(bass.first[it], mid.first[it]) } to FloatArray(n) { min(bass.second[it], mid.second[it]) }, c)
			}
			band(heights({ it.treble }, gT), skin.treble)
		}
		WaveModel.STACKED -> {
			val smooth = skin.smoothWindow > 1
			// Bass on the baseline, mid on it, treble on that. Stereo grows both ways from the centre at half the height.
			fun half(c: Columns, baseline: Float, dir: Int, scale: Float) {
				var under = FloatArray(n) { baseline }
				for ((amp, gain, color) in listOf(Triple(c.bass, gB, skin.bass), Triple(c.mid, gM, skin.mid), Triple(c.treble, gT, skin.treble))) {
					val from = under
					val top = FloatArray(n) { from[it] + dir * h(amp[it], gain) * scale }
					val path = Path()
					path.moveTo(x(0), from[0])
					path.curve(n, forward = true, smooth, ::x) { top[it] }
					path.curve(n, forward = false, smooth, ::x) { from[it] }
					path.close()
					canvas.drawPath(path, fill(color))
					under = top
				}
			}
			if (stereo) {
				half(left, bars.center, -1, 0.5f)
				half(right, bars.center, 1, 0.5f)
			} else half(left, bars.floor, -1, 1f)
		}
		WaveModel.SPECTRUM -> {
			val paint = Paint()
			fun column(c: Columns, i: Int, dir: Int) {
				val b = level(c.bass[i]) * gB
				val m = level(c.mid[i]) * gM
				val t = level(c.treble[i]) * gT
				paint.color = spectrumColor(skin, b, m, t) ?: return
				val half = min(1f, max(b, max(m, t))) * bars.barH / 2
				canvas.drawRect(edge(i).toFloat(), min(bars.center, bars.center + dir * half), edge(i + 1).toFloat(), max(bars.center, bars.center + dir * half), paint)
			}
			for (i in 0 until n) {
				column(left, i, -1)
				column(right, i, 1)
			}
		}
		WaveModel.ENVELOPE -> {
			// The peak outline, and inside it the darker rms body (a share of the peak where the file has none).
			val rmsLeft = peaks.rms?.let { cols(it) }
			val rmsRight = if (stereo) peaks.rightRms?.let { cols(it) } else rmsLeft
			fun sum(c: Columns, i: Int) = c.bass[i] + c.mid[i] + c.treble[i]
			fun peak(c: Columns, i: Int) = h(sum(c, i), gB) / 2
			fun body(c: Columns, rms: Columns?, i: Int) = if (rms == null) peak(c, i) * ENVELOPE_BODY else min(peak(c, i), h(sum(rms, i), gB) / 2)
			val outline = Paint().apply { color = skin.bass }
			val inner = Paint().apply { color = darken(skin.bass, 0.55f) }
			for (i in 0 until n) {
				val x0 = edge(i).toFloat()
				val x1 = edge(i + 1).toFloat()
				canvas.drawRect(x0, bars.center - peak(left, i), x1, bars.center + peak(right, i), outline)
				canvas.drawRect(x0, bars.center - body(left, rmsLeft, i), x1, bars.center + body(right, rmsRight, i), inner)
			}
		}
	}
}

/** The whole track in [width] pixels: crisp columns, the skin's map look. */
fun paintMap(canvas: Canvas, peaks: Peaks, skin: WaveSkin, durationSec: Double, width: Int, height: Int, columnPx: Float) {
	val n = ceil(width / columnPx).toInt()
	val c = columns(peaks.left, 0, n, durationSec * peaks.samplesPerSec * columnPx / width, skin)
	val bars = Bars(height)
	fun level(v: Float) = min(1f, v / peaks.norm).pow(skin.gamma)
	fun h(v: Float, gain: Float) = level(v) * bars.barH * gain
	val (gB, gM, gT) = skin.mapGains
	val paint = Paint()
	for (i in 0 until n) {
		val x0 = (i * columnPx).roundToInt().toFloat()
		val x1 = ((i + 1) * columnPx).roundToInt().toFloat()
		fun rect(top: Float, bottom: Float, color: Int) {
			if (bottom <= top) return
			paint.color = color
			canvas.drawRect(x0, top, x1, bottom, paint)
		}
		fun centred(half: Float, color: Int) = rect(bars.center - half, bars.center + half, color)
		val b = c.bass[i]
		val m = c.mid[i]
		val t = c.treble[i]
		when (skin.map) {
			MapModel.STACKED -> {
				var at = bars.floor
				for ((hh, color) in listOf(h(b, gB) to skin.bass, h(m, gM) to skin.mid, h(t, gT) to skin.treble)) {
					rect(at - hh, at, color)
					at -= hh
				}
			}
			MapModel.SPECTRUM -> {
				val lb = level(b) * gB
				val lm = level(m) * gM
				val lt = level(t) * gT
				spectrumColor(skin, lb, lm, lt)?.let { centred(min(1f, max(lb, max(lm, lt))) * bars.barH / 2, it) }
			}
			MapModel.ENVELOPE -> {
				val half = h(b + m + t, gB) / 2
				centred(half, skin.bass)
				centred(half * ENVELOPE_BODY, darken(skin.bass, 0.55f))
			}
			// All the bands, then without the bass, then the treble alone: each inside the one before.
			MapModel.NESTED -> {
				centred(h(b + m + t, gB) / 2, skin.bass)
				centred(h(m + t, gM) / 2, skin.mid)
				centred(h(t, gT) / 2, skin.treble)
			}
		}
	}
}

// Through the points 0..n-1 (or back): straight between them, or curved
// through the midpoints with the points as controls (smoothLineTo).
private fun Path.curve(n: Int, forward: Boolean, smooth: Boolean, x: (Int) -> Float, y: (Int) -> Float) {
	fun at(k: Int) = if (forward) k else n - 1 - k
	if (!smooth) {
		for (k in 0 until n) lineTo(x(at(k)), y(at(k)))
		return
	}
	lineTo(x(at(0)), y(at(0)))
	for (k in 1 until n - 1) {
		val i = at(k)
		val j = at(k + 1)
		if (k == 1) lineTo((x(at(0)) + x(i)) / 2, (y(at(0)) + y(i)) / 2)
		quadTo(x(i), y(i), (x(i) + x(j)) / 2, (y(i) + y(j)) / 2)
	}
	lineTo(x(at(n - 1)), y(at(n - 1)))
}
