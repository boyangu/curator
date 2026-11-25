package app.curator.mobile.ui.track

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import app.curator.mobile.model.Peaks
import app.curator.mobile.model.WaveSkin
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What a wave is painted from; a tile holds for as long as none of it changes. */
data class WaveKey(val peaks: Peaks, val skin: WaveSkin, val pxPerSec: Double, val height: Int, val columnPx: Float)

/**
 * The big wave, painted once into bitmap tiles and then only moved, by whole
 * pixels: nothing about it can change from frame to frame, and a frame costs a
 * few bitmap draws. Painting it each frame would not only cost more: its
 * anti-aliased edges would shimmer as they cross pixels.
 *
 * Never painted in a frame, which would hold the playing wave up (a window of
 * tiles takes a tenth of a second and more): off the main thread, ahead of
 * where the wave is going. What isn't ready shows from what is: while the
 * scale changes (a pinch, the zoom button) the tiles at hand stretched, and
 * where there are none (zoomed out past them, a seek, a fast drag) the whole
 * track painted once, coarsely.
 */
class WaveTiles(private val scope: CoroutineScope) {
	private class Sheet(val key: WaveKey) {
		val tiles = HashMap<Int, Bitmap>()
		// Past the track's end there is nothing to paint.
		val last = floor(key.peaks.seconds * key.pxPerSec / TILE).toInt()

		fun covering(origin: Int, width: Int) = Math.floorDiv(origin, TILE)..Math.floorDiv(origin + width - 1, TILE)
	}

	private class Want(val key: WaveKey, val origin: Int, val width: Int)

	private var sheet: Sheet? = null
	private var whole: Sheet? = null
	private var want: Want? = null
	private var job: Job? = null
	// Read by the draw: what was just painted draws again.
	private val done = mutableIntStateOf(0)
	private val stretched = Paint(Paint.FILTER_BITMAP_FLAG)

	/** Draws the [width] pixels from [origin], the wave's pixel at the canvas's left edge, with the top at [top]. */
	fun draw(canvas: Canvas, key: WaveKey, origin: Int, width: Int, top: Int) {
		done.intValue
		want = Want(key, origin, width)
		if (sheet?.key?.peaks !== key.peaks) sheet = null
		if (whole?.key?.peaks !== key.peaks) whole = null
		val s = sheet
		if (s == null) whole?.let { drawWhole(canvas, it, key, origin, 0, width, top) }
		else {
			val by = key.pxPerSec / s.key.pxPerSec
			val from = floor(origin / by / TILE).toInt()
			val to = floor((origin + width - 1) / by / TILE).toInt()
			for (i in from..to) {
				val x0 = floor(i * TILE * by).toInt() - origin
				val x1 = floor((i + 1) * TILE * by).toInt() - origin
				val tile = s.tiles[i]
				when {
					tile == null -> whole?.let { drawWhole(canvas, it, key, origin, max(0, x0), min(width, x1), top) }
					by == 1.0 && s.key.height == key.height -> canvas.drawBitmap(tile, x0.toFloat(), top.toFloat(), null)
					else -> canvas.drawBitmap(tile, null, Rect(x0, top, x1, top + key.height), stretched)
				}
			}
			if (s.key == key) s.tiles.keys.removeAll { it < from - KEPT || it > to + KEPT }
		}
		if (job?.isActive != true) job = scope.launch { paintAll() }
	}

	// The whole track's picture, between two pixels of the canvas.
	private fun drawWhole(canvas: Canvas, s: Sheet, key: WaveKey, origin: Int, from: Int, to: Int, top: Int) {
		if (to <= from) return
		val by = key.pxPerSec / s.key.pxPerSec
		canvas.save()
		canvas.clipRect(from, top, to, top + key.height)
		for ((i, tile) in s.tiles) {
			val x0 = floor(i * TILE * by).toInt() - origin
			val x1 = floor((i + 1) * TILE * by).toInt() - origin
			if (x1 > from && x0 < to) canvas.drawBitmap(tile, null, Rect(x0, top, x1, top + key.height), stretched)
		}
		canvas.restore()
	}

	// What is wanted and not there, until all of it is.
	private suspend fun paintAll() {
		while (true) {
			val w = want ?: return
			val s = sheet
			if (s == null || s.key != w.key) {
				// A little off and still changing: stretched will do until the fingers rest.
				if (s != null && w.key.copy(pxPerSec = s.key.pxPerSec) == s.key && w.key.pxPerSec / s.key.pxPerSec in 1 / SOFT..SOFT) {
					delay(REST_MS)
					if (want?.key != w.key) continue
				}
				val next = Sheet(w.key)
				paint(next, next.covering(w.origin, w.width))
				if (want?.key?.peaks === w.key.peaks) sheet = next
			} else {
				val now = s.covering(w.origin, w.width)
				val missing = now.filter { it in 0..s.last && it !in s.tiles }
					.ifEmpty { listOf(now.last + 1, now.first - 1).filter { it in 0..s.last && it !in s.tiles } }
				if (missing.isNotEmpty()) paint(s, missing)
				else {
					val coarse = w.key.copy(pxPerSec = min(WHOLE_PX_PER_SEC, w.key.pxPerSec), columnPx = 1f)
					if (whole?.key?.copy(pxPerSec = coarse.pxPerSec) == coarse) return
					val next = Sheet(coarse)
					paint(next, 0..next.last)
					if (want?.key?.peaks === w.key.peaks) whole = next
				}
			}
			done.intValue++
		}
	}

	private suspend fun paint(s: Sheet, which: Iterable<Int>) = coroutineScope {
		which.filter { it in 0..s.last }
			.map { i -> async(Dispatchers.Default) { i to paint(s.key, i) } }
			.forEach { it.await().let { (i, tile) -> s.tiles[i] = tile } }
	}

	private fun paint(key: WaveKey, i: Int): Bitmap {
		val b = Bitmap.createBitmap(TILE, key.height, Bitmap.Config.ARGB_8888)
		paintWave(Canvas(b), key.peaks, key.skin, key.pxPerSec, i * TILE, TILE, key.height, key.columnPx)
		b.prepareToDraw()
		return b
	}

	private companion object {
		const val TILE = 512
		// Tiles kept past each edge of the window.
		const val KEPT = 3
		// How far a scale may be stretched before the next is painted, and how long fingers stand still to be resting.
		const val SOFT = 1.25
		const val REST_MS = 80L
		// The whole track's picture: some 4000 pixels for a long track.
		const val WHOLE_PX_PER_SEC = 10.0
	}
}

@Composable
fun rememberWaveTiles(): WaveTiles {
	val scope = rememberCoroutineScope()
	return remember { WaveTiles(scope) }
}
