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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.ceil
import kotlin.math.floor

/** What a wave is painted from; a tile holds for as long as none of it changes. */
data class WaveKey(val peaks: Peaks, val skin: WaveSkin, val pxPerSec: Double, val height: Int, val columnPx: Float)

/**
 * The big wave, painted once into bitmap tiles and then only moved, by whole
 * pixels: nothing about it can change from frame to frame, and a frame costs a
 * few bitmap draws. Painting it each frame would not only cost more: its
 * anti-aliased edges would shimmer as they cross pixels.
 *
 * Tiles the wave is about to need are painted ahead, off the main thread; one
 * missing now (a seek, a fast drag) is painted in the draw, which may cost a
 * frame but never shows a hole. While a pinch changes the scale, the tiles at
 * hand are drawn stretched until the new scale's are ready.
 */
class WaveTiles(private val scope: CoroutineScope) {
	private class Sheet(val key: WaveKey) {
		val tiles = HashMap<Int, Bitmap>()
		// Past the track's end there is nothing to paint.
		val last = floor(key.peaks.seconds * key.pxPerSec / TILE).toInt()
	}

	private var sheet: Sheet? = null
	private var job: Job? = null
	// Read by the draw: a finished job draws again.
	private val done = mutableIntStateOf(0)
	private val stretched = Paint(Paint.FILTER_BITMAP_FLAG)

	/** Draws the [width] pixels from [origin], the wave's pixel at the canvas's left edge, with the top at [top]. */
	fun draw(canvas: Canvas, key: WaveKey, origin: Int, width: Int, top: Int) {
		done.intValue
		val had = sheet
		if (had != null && had.key != key && had.key.copy(pxPerSec = key.pxPerSec) == key && key.pxPerSec / had.key.pxPerSec in 1 / MAX_STRETCH..MAX_STRETCH) {
			drawStretched(canvas, had, key.pxPerSec / had.key.pxPerSec, origin, width, top)
			rescale(had, key, origin, width)
			return
		}
		val now = if (had?.key == key) had else Sheet(key).also { sheet = it }
		val from = Math.floorDiv(origin, TILE)
		val to = Math.floorDiv(origin + width - 1, TILE)
		now.tiles.keys.removeAll { it < from - KEPT || it > to + KEPT }
		for (i in from..to) {
			if (i !in 0..now.last) continue
			val tile = now.tiles.getOrPut(i) { paint(key, i) }
			canvas.drawBitmap(tile, (i * TILE - origin).toFloat(), top.toFloat(), null)
		}
		ahead(now, listOf(to + 1, from - 1))
	}

	private fun drawStretched(canvas: Canvas, s: Sheet, by: Double, origin: Int, width: Int, top: Int) {
		for ((i, tile) in s.tiles) {
			val x0 = floor(i * TILE * by).toInt() - origin
			val x1 = ceil((i + 1) * TILE * by).toInt() - origin
			if (x1 > 0 && x0 < width) canvas.drawBitmap(tile, null, Rect(x0, top, x1, top + s.key.height), stretched)
		}
	}

	// One at a time: a pinch asks again with each draw, and gets the latest scale once this one is in.
	private fun rescale(had: Sheet, key: WaveKey, origin: Int, width: Int) = work {
		val next = Sheet(key)
		for (i in Math.floorDiv(origin, TILE) - 1..Math.floorDiv(origin + width - 1, TILE) + 1) {
			if (i in 0..next.last) next.tiles[i] = withContext(Dispatchers.Default) { paint(key, i) }
		}
		if (sheet === had) sheet = next
	}

	private fun ahead(s: Sheet, want: List<Int>) {
		val missing = want.filter { it in 0..s.last && it !in s.tiles }
		if (missing.isEmpty()) return
		work { for (i in missing) s.tiles[i] = withContext(Dispatchers.Default) { paint(s.key, i) } }
	}

	private fun work(block: suspend () -> Unit) {
		if (job?.isActive == true) return
		job = scope.launch {
			block()
			done.intValue++
		}
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
		// Past this (a tap on the zoom button) stretching would show holes: the new scale is painted at once.
		const val MAX_STRETCH = 1.3
	}
}

@Composable
fun rememberWaveTiles(): WaveTiles {
	val scope = rememberCoroutineScope()
	return remember { WaveTiles(scope) }
}
