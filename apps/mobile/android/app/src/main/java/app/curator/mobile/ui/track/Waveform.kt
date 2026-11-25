package app.curator.mobile.ui.track

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Cue
import app.curator.mobile.data.Phrase
import app.curator.mobile.model.Bands
import app.curator.mobile.model.Finger
import app.curator.mobile.model.Peaks
import app.curator.mobile.model.WaveSkin
import app.curator.mobile.model.WaveTouch
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.CuePalette
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.oklch
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A phrase's colour in the lane under a wave, on the skin's ramp. */
private fun phraseColor(skin: WaveSkin, label: String): Color = skin.phrase(label).let { oklch(it.l, it.c, it.h) }

private val trailingNumber = Regex("\\s*\\d+$")

fun phraseName(label: String): String = label.replace(trailingNumber, "").ifEmpty { "Phrase" }

/** The whole track's wave as a picture: painted off the main thread when the track, skin or size changes. */
@Composable
private fun rememberMap(peaks: Peaks?, skin: WaveSkin, durationSec: Double, size: IntSize): ImageBitmap? {
	val column = LocalDensity.current.density
	val map by produceState<Pair<Peaks, ImageBitmap>?>(null, peaks, skin, durationSec, size) {
		if (peaks == null || durationSec <= 0 || size.width <= 0 || size.height <= 0) { value = null; return@produceState }
		value = peaks to withContext(Dispatchers.Default) {
			val b = Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888)
			paintMap(android.graphics.Canvas(b), peaks, skin, durationSec, size.width, size.height, column)
			b.asImageBitmap()
		}
	}
	// Until the new one is ready the last stays (a skin or size change), but never another track's.
	return map?.takeIf { it.first === peaks }?.second
}

/** A wave not there (yet): a flat line. */
private fun DrawScope.noWave(top: Float, height: Float) =
	drawLine(C.fg4, Offset(0f, top + height / 2), Offset(size.width, top + height / 2), 1.dp.toPx())

private fun DrawScope.cueBadge(measurer: TextMeasurer, cue: Cue, x: Float, y: Float, w: Float, h: Float, fontSp: Float) {
	drawRect(CuePalette.color(cue.color), Offset(x, y), Size(w, h))
	val label = measurer.measure(cue.letter, T.mono(fontSp.sp, Color.Black))
	drawText(label, topLeft = Offset(x + (w - label.size.width) / 2, y + (h - label.size.height) / 2))
}

private fun secAt(x: Float, width: Int, durationSec: Double) = (x / width * durationSec).coerceIn(0.0, durationSec)

/**
 * The touches on a wave, told apart by [WaveTouch]: a scrub from [onBegin] to
 * [onEnd] (at its last x) or [onCallOff], a pinch to [onSpread].
 */
private fun Modifier.waveTouch(
	key: Any?,
	yields: Boolean,
	onBegin: () -> Unit = {},
	onScrub: PointerInputScope.(x: Float, dx: Float) -> Unit,
	onEnd: PointerInputScope.(x: Float) -> Unit,
	onCallOff: () -> Unit,
	onSpread: (Float) -> Unit = {},
): Modifier = pointerInput(key) {
	val input = this
	awaitEachGesture {
		val touch = WaveTouch(viewConfiguration.touchSlop, yields)
		val down = awaitFirstDown()
		touch.on(listOf(Finger(down.id.value, down.position.x, down.position.y)))
		var x = down.position.x
		try {
			do {
				val ev = awaitPointerEvent()
				val pressed = ev.changes.filter { it.pressed }
				val act = touch.on(pressed.map { Finger(it.id.value, it.position.x, it.position.y) }, taken = pressed.any { it.isConsumed })
				when (act) {
					is WaveTouch.Act.Begin -> { x = pressed[0].position.x; onBegin() }
					is WaveTouch.Act.Scrub -> { x = act.x; input.onScrub(act.x, act.dx) }
					is WaveTouch.Act.Spread -> onSpread(act.factor)
					is WaveTouch.Act.End -> input.onEnd(x)
					is WaveTouch.Act.CallOff -> onCallOff()
					is WaveTouch.Act.Idle -> {}
				}
				// Taken: no tap, page swipe or scroll is made of it as well.
				if (act !is WaveTouch.Act.Idle || act.ours) ev.changes.forEach { it.consume() }
			} while (pressed.isNotEmpty())
		} finally {
			if (touch.cancel() is WaveTouch.Act.CallOff) onCallOff()
		}
	}
}

/**
 * The whole track: played part dimmed, white 2dp playhead, cue letters on the
 * top edge, the phrase lane under it. Tap or drag seeks (a drag scrubs and
 * seeks on release). [windowSec], in landscape: how much the big wave shows,
 * outlined in accent; dragging that box scrolls the big wave (it scrubs).
 * [position] is read while drawing: a moving playhead only draws again.
 */
@Composable
fun OverviewMap(
	peaks: Peaks?,
	skin: WaveSkin,
	durationSec: Double,
	position: () -> Double,
	cues: List<Cue>,
	modifier: Modifier,
	windowSec: Double? = null,
	badge: Size = Size(14f, 13f),
	onScrub: (Double) -> Unit,
	onCallOff: () -> Unit,
	onSeek: (Double) -> Unit,
) {
	val measurer = rememberTextMeasurer()
	val seek by rememberUpdatedState(onSeek)
	val scrub by rememberUpdatedState(onScrub)
	val callOff by rememberUpdatedState(onCallOff)
	val dur = durationSec.takeIf { it > 0 } ?: peaks?.seconds ?: 0.0
	var box by remember { mutableStateOf(IntSize.Zero) }
	val inset = with(LocalDensity.current) { 4.dp.roundToPx() }
	val map = rememberMap(peaks, skin, dur, IntSize(box.width, box.height - 2 * inset))
	Box(modifier.background(C.bg1).border(1.dp, C.lineSoft)) {
		Canvas(
			Modifier
				.fillMaxSize()
				.onSizeChanged { box = it }
				.pointerInput(dur) { detectTapGestures { o -> if (dur > 0) seek((o.x / size.width) * dur) } }
				.waveTouch(
					dur, yields = true,
					onScrub = { x, _ -> if (dur > 0) scrub(secAt(x, size.width, dur)) },
					onEnd = { x -> if (dur > 0) seek(secAt(x, size.width, dur)) },
					onCallOff = { callOff() },
				),
		) {
			if (map != null) drawImage(map, topLeft = Offset(0f, inset.toFloat())) else noWave(0f, size.height)
			if (dur <= 0) return@Canvas
			val at = position()
			val px = (at / dur).toFloat() * size.width
			drawRect(C.played, Offset.Zero, Size(px, size.height))
			windowSec?.let { w ->
				// Within the track: at its start or end the window is cut by the edge.
				val a = ((at - w / 2).coerceIn(0.0, dur) / dur).toFloat() * size.width
				val z = ((at + w / 2).coerceIn(0.0, dur) / dur).toFloat() * size.width
				drawRect(C.accent.copy(alpha = 0.10f), Offset(a, 0f), Size(z - a, size.height))
				drawRect(C.accent, Offset(a, 0f), Size(z - a, size.height), style = Stroke(1.dp.toPx()))
			}
			drawRect(Color.White, Offset(px - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
			for (q in cues) {
				val x = (q.positionSec / dur).toFloat() * size.width
				cueBadge(measurer, q, x, 0f, badge.width.dp.toPx(), badge.height.dp.toPx(), if (badge.width > 13f) 10f else 9.5f)
			}
		}
	}
}

/** The phrase lane under a map: 5dp, a 2dp gap between phrases. */
@Composable
fun PhraseLane(phrases: List<Phrase>, skin: WaveSkin, durationSec: Double, modifier: Modifier) {
	Canvas(modifier) {
		if (durationSec <= 0) return@Canvas
		val gap = 2.dp.toPx()
		for (p in phrases) {
			val a = (p.startSec / durationSec).toFloat() * size.width
			val z = (p.endSec / durationSec).toFloat() * size.width
			drawRect(phraseColor(skin, p.label), Offset(a, 0f), Size(max(0f, z - a - gap), size.height))
		}
	}
}

/** Beat facts at a time: bar number and beat within it (1-based), from the grid. */
data class BarBeat(val bar: Int, val beat: Int)

fun barBeat(beats: FloatArray, downbeats: FloatArray, t: Double): BarBeat? {
	if (beats.isEmpty()) return null
	val bar = downbeats.count { it <= t }.coerceAtLeast(1)
	val lastDown = downbeats.lastOrNull { it <= t } ?: beats.first()
	val beat = beats.count { it >= lastDown - 0.001f && it <= t }.coerceIn(1, 16)
	return BarBeat(bar, beat)
}

/** The beat length near a time (grid spacing, else from the BPM). */
fun beatLength(beats: FloatArray, bpm: Double?, t: Double): Double {
	if (beats.size >= 2) {
		val i = beats.indexOfFirst { it > t }.let { if (it <= 0) 1 else it }.coerceAtMost(beats.size - 1)
		return (beats[i] - beats[i - 1]).toDouble().takeIf { it > 0.05 } ?: 0.5
	}
	return 60.0 / (bpm ?: 120.0)
}

/**
 * The seconds [bars] bars take: by the whole grid's average beat, so the zoom
 * holds still. One beat's own length differs from the next's by a rounding,
 * and the wave would breathe with it.
 */
fun windowSec(beats: FloatArray, bpm: Double?, bars: Float): Double {
	val beat = if (beats.size >= 2) (beats.last() - beats.first()).toDouble() / (beats.size - 1) else 60.0 / (bpm ?: 120.0)
	return bars * 4 * beat.coerceAtLeast(0.05)
}

/** Seconds [n] beats from [t] on the grid (or the BPM's beat). */
fun jumpBeats(beats: FloatArray, bpm: Double?, t: Double, n: Int): Double {
	if (beats.size < 2) return t + n * 60.0 / (bpm ?: 120.0)
	var i = beats.indexOfLast { it <= t + 0.02 }
	if (i < 0) i = 0
	val j = i + n
	return when {
		j < 0 -> 0.0
		j >= beats.size -> beats.last() + (j - beats.lastIndex) * beatLength(beats, bpm, t)
		else -> beats[j].toDouble()
	}
}

/**
 * The zoomed wave (landscape): the playhead fixed at the centre, [bars] bars
 * across, the grid's beats in line-soft and bars in fg-4 with their numbers,
 * cue lines full height with their letter at the bottom, the phrase lane on
 * the bottom edge. A horizontal drag scrubs ([onScrub] as it moves, [onSeek]
 * on release: streaming sources only seek then); two fingers zoom and leave
 * playback alone ([onCallOff]: a scrub their first one began is none).
 *
 * [position] is read while drawing, so a frame of playback draws and nothing
 * recomposes. Everything sits at a whole pixel of the wave and the window moves
 * by whole pixels: a frame is the last one shifted, or the edges would shimmer.
 */
@Composable
fun BigWave(
	peaks: Peaks?,
	skin: WaveSkin,
	position: () -> Double,
	durationSec: Double,
	beats: FloatArray,
	downbeats: FloatArray,
	span: Double,
	cues: List<Cue>,
	phrases: List<Phrase>,
	modifier: Modifier,
	onScrub: (Double) -> Unit,
	onCallOff: () -> Unit,
	onSeek: (Double) -> Unit,
	onZoom: (Float) -> Unit,
) {
	// Every bar number on screen stays measured; the default keeps eight.
	val measurer = rememberTextMeasurer(cacheSize = 256)
	val tiles = rememberWaveTiles()
	val pos by rememberUpdatedState(position)
	val scrub by rememberUpdatedState(onScrub)
	val callOff by rememberUpdatedState(onCallOff)
	val seek by rememberUpdatedState(onSeek)
	val zoom by rememberUpdatedState(onZoom)
	val spanNow by rememberUpdatedState(span)
	val lengthNow by rememberUpdatedState(durationSec)
	val drag = remember { mutableDoubleStateOf(0.0) }
	Box(modifier.background(C.bg1).border(1.dp, C.lineSoft)) {
		Canvas(
			Modifier
				.fillMaxSize()
				// Phrases, cue badges and the grid reach past the window's edges.
				.clipToBounds()
				.waveTouch(
					Unit, yields = false,
					// From where it is now, not where it was at the touch.
					onBegin = { drag.doubleValue = pos() },
					onScrub = { _, dx ->
						drag.doubleValue = (drag.doubleValue - dx / size.width * spanNow).coerceIn(0.0, lengthNow.coerceAtLeast(0.0))
						scrub(drag.doubleValue)
					},
					onEnd = { seek(drag.doubleValue) },
					onCallOff = { callOff() },
					onSpread = { zoom(1 / it) },
				),
		) {
			val pxPerSec = size.width / span
			val playhead = (size.width / 2).roundToInt()
			val origin = (position() * pxPerSec).roundToInt() - playhead
			fun x(t: Double) = ((t * pxPerSec).roundToInt() - origin).toFloat()
			// A margin for what reaches past its own time (a number, a badge).
			val from = (origin - 40.dp.toPx()) / pxPerSec
			val to = (origin + size.width) / pxPerSec
			val line = 1.dp.toPx()
			// Grid: every beat line-soft, every bar fg-4 with its number.
			for (i in beats.firstFrom(from) until beats.size) {
				if (beats[i] > to) break
				drawRect(C.lineSoft, Offset(x(beats[i].toDouble()), 0f), Size(line, size.height))
			}
			for (i in downbeats.firstFrom(from) until downbeats.size) {
				if (downbeats[i] > to) break
				val xx = x(downbeats[i].toDouble())
				drawRect(C.fg4, Offset(xx, 0f), Size(line, size.height))
				drawText(measurer.measure((i + 1).toString(), barNumber), topLeft = Offset(xx + 4.dp.toPx(), 3.dp.toPx()))
			}
			val top = 16.dp.roundToPx()
			val height = size.height.toInt() - 2 * top
			if (peaks == null || height <= 0) noWave(top.toFloat(), height.toFloat())
			else tiles.draw(drawContext.canvas.nativeCanvas, WaveKey(peaks, skin, pxPerSec, height, density), origin, size.width.toInt(), top)
			for (q in cues) {
				if (q.positionSec < from || q.positionSec > to) continue
				val xx = x(q.positionSec)
				val col = CuePalette.color(q.color)
				drawRect(col, Offset(xx, 0f), Size(2.dp.toPx(), size.height))
				cueBadge(measurer, q, xx, size.height - 5.dp.toPx() - 15.dp.toPx(), 16.dp.toPx(), 15.dp.toPx(), 11f)
			}
			val lane = 5.dp.toPx()
			for (p in phrases) {
				if (p.endSec < from || p.startSec > to) continue
				drawRect(phraseColor(skin, p.label), Offset(x(p.startSec), size.height - lane), Size(x(p.endSec) - x(p.startSec) - 2.dp.toPx(), lane))
			}
			drawRect(Color.White, Offset(playhead - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
		}
	}
}

private val barNumber = T.mono(10.5.sp, C.fg3)

/** The index of the first time at or after [t] (they are sorted). */
private fun FloatArray.firstFrom(t: Double): Int = java.util.Arrays.binarySearch(this, t.toFloat()).let { if (it < 0) -it - 1 else it }

/** A skin as a short wave in it: what its picker shows. */
@Composable
fun SkinSwatch(skin: WaveSkin, modifier: Modifier) {
	Canvas(modifier.clipToBounds()) {
		paintWave(drawContext.canvas.nativeCanvas, swatchPeaks, skin, size.width / swatchPeaks.seconds, 0, size.width.toInt(), size.height.toInt(), density)
	}
}

// Two bars' worth of kick, off-beat and hats.
private val swatchPeaks: Peaks = run {
	fun band(level: Int, every: Int, from: Int, decay: Double) =
		ByteArray(64) { i -> (level * Math.pow(decay, ((i + every - from) % every).toDouble())).toInt().toByte() }
	Peaks(Bands(band(230, 16, 0, 0.82), band(150, 16, 8, 0.80), band(170, 8, 4, 0.60)), null, null, null, 16)
}

/** "Bar 33.1 · Build" at the playhead. */
fun readout(beats: FloatArray, downbeats: FloatArray, phrases: List<Phrase>, t: Double): String? {
	val bb = barBeat(beats, downbeats, t) ?: return null
	val phrase = phrases.firstOrNull { t >= it.startSec && t < it.endSec }?.let { " · ${phraseName(it.label)}" } ?: ""
	return "Bar ${bb.bar}.${bb.beat}$phrase"
}
