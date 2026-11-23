package app.curator.mobile.ui.track

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Cue
import app.curator.mobile.data.Phrase
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.CuePalette
import app.curator.mobile.ui.theme.T
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * A track's waveform peaks: the `.cpk` detail block (apps/core analyzer/cpk.ts),
 * first channel, peak metric, three bands as 0..1.
 */
class Peaks(val low: FloatArray, val mid: FloatArray, val high: FloatArray, val samplesPerSec: Int) {
	val size: Int get() = low.size
	val seconds: Double get() = size.toDouble() / samplesPerSec

	companion object {
		fun parse(b: ByteArray): Peaks? {
			if (b.size < 21 || String(b, 0, 8, Charsets.US_ASCII) != "CURPEAKS") return null
			val buf = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
			val version = b[8].toInt()
			val bands = b[9].toInt()
			if (bands != 3) return null
			val (channels, sps, detail, header) = if (version == 1) {
				listOf(1, buf.getShort(10).toInt() and 0xffff, buf.getInt(12), 20)
			} else listOf(b[10].toInt(), buf.getShort(11).toInt() and 0xffff, buf.getInt(13), 21)
			val metrics = if (version >= 3) 2 else 1
			val stride = bands * metrics * channels
			if (sps <= 0 || detail <= 0 || header + detail.toLong() * stride > b.size) return null
			val lo = FloatArray(detail); val md = FloatArray(detail); val hi = FloatArray(detail)
			for (i in 0 until detail) {
				val at = header + i * stride
				lo[i] = (b[at].toInt() and 0xff) / 255f
				md[i] = (b[at + 1].toInt() and 0xff) / 255f
				hi[i] = (b[at + 2].toInt() and 0xff) / 255f
			}
			return Peaks(lo, md, hi, sps)
		}
	}
}

/** Phrase lane colours: intro, break and outro calm; builds; drops (rekordbox's and the analyzer's labels). */
fun phraseColor(label: String): Color {
	val l = label.lowercase()
	return when {
		l.startsWith("up") || "build" in l || "rise" in l -> C.phraseBuild
		"chorus" in l || "drop" in l || "peak" in l -> C.phraseDrop
		else -> C.phraseCalm
	}
}

fun phraseName(label: String): String = label.replace(Regex("\\s*\\d+$"), "").ifEmpty { "Phrase" }

// The Silver skin's stacked bands, mirrored on the centre line: bass the
// mass, mid riding its edge, treble the thin tips.
private fun DrawScope.drawBands(peaks: Peaks?, from: Double, to: Double, top: Float, height: Float, columnPx: Float) {
	val mid = top + height / 2
	val half = height / 2
	if (peaks == null || peaks.size == 0) {
		drawLine(C.fg4, Offset(0f, mid), Offset(size.width, mid), 1.dp.toPx())
		return
	}
	val cols = max(1, (size.width / columnPx).toInt())
	val secPerCol = (to - from) / cols
	for (c in 0 until cols) {
		val a = ((from + c * secPerCol) * peaks.samplesPerSec).toInt()
		val z = ((from + (c + 1) * secPerCol) * peaks.samplesPerSec).toInt().coerceAtLeast(a + 1)
		if (z <= 0 || a >= peaks.size) continue
		var lo = 0f; var md = 0f; var hi = 0f
		for (i in max(0, a) until min(peaks.size, z)) {
			lo = max(lo, peaks.low[i]); md = max(md, peaks.mid[i]); hi = max(hi, peaks.high[i])
		}
		val bass = lo * half * 0.82f
		val midH = md * half * 0.22f
		val treble = hi * half * 0.10f
		val x = c * columnPx
		val w = max(1f, columnPx - 1f)
		drawRect(C.waveTreble, Offset(x, mid - bass - midH - treble), Size(w, (bass + midH + treble) * 2))
		drawRect(C.waveMid, Offset(x, mid - bass - midH), Size(w, (bass + midH) * 2))
		drawRect(C.waveBass, Offset(x, mid - bass), Size(w, bass * 2))
	}
}

private fun DrawScope.cueBadge(measurer: TextMeasurer, cue: Cue, x: Float, y: Float, w: Float, h: Float, fontSp: Float) {
	drawRect(CuePalette.color(cue.color), Offset(x, y), Size(w, h))
	val label = measurer.measure(cue.letter, T.mono(fontSp.sp, Color.Black))
	drawText(label, topLeft = Offset(x + (w - label.size.width) / 2, y + (h - label.size.height) / 2))
}

/**
 * The whole track: played part dimmed, white 2dp playhead, cue letters on the
 * top edge, the phrase lane under it. Tap or drag seeks (a drag scrubs and
 * seeks on release). [window], in landscape: the seconds the big wave shows,
 * outlined in accent; dragging that box scrolls the big wave (it scrubs).
 */
@Composable
fun OverviewMap(
	peaks: Peaks?,
	durationSec: Double,
	positionSec: Double,
	cues: List<Cue>,
	modifier: Modifier,
	window: ClosedFloatingPointRange<Double>? = null,
	badge: Size = Size(14f, 13f),
	onScrub: (Double) -> Unit,
	onSeek: (Double) -> Unit,
) {
	val measurer = rememberTextMeasurer()
	val seek by rememberUpdatedState(onSeek)
	val scrub by rememberUpdatedState(onScrub)
	val dur = durationSec.takeIf { it > 0 } ?: peaks?.seconds ?: 0.0
	Box(modifier.background(C.bg1).border(1.dp, C.lineSoft)) {
		Canvas(
			Modifier
				.fillMaxSize()
				.pointerInput(dur) { detectTapGestures { o -> if (dur > 0) seek((o.x / size.width) * dur) } }
				.pointerInput(dur) {
					awaitEachGesture {
						val down = awaitFirstDown()
						var at = (down.position.x / size.width) * dur
						var moved = false
						horizontalDrag(down.id) { ch ->
							ch.consume()
							moved = true
							at = ((ch.position.x / size.width) * dur).coerceIn(0.0, dur)
							scrub(at)
						}
						if (moved && dur > 0) seek(at)
					}
				},
		) {
			drawBands(peaks, 0.0, dur, 4.dp.toPx(), size.height - 8.dp.toPx(), 2.dp.toPx())
			if (dur <= 0) return@Canvas
			val px = (positionSec / dur).toFloat() * size.width
			drawRect(C.played, Offset.Zero, Size(px, size.height))
			window?.let { w ->
				// Within the track: at its start or end the window is cut by the edge.
				val a = (w.start.coerceIn(0.0, dur) / dur).toFloat() * size.width
				val z = (w.endInclusive.coerceIn(0.0, dur) / dur).toFloat() * size.width
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
fun PhraseLane(phrases: List<Phrase>, durationSec: Double, modifier: Modifier) {
	Canvas(modifier) {
		if (durationSec <= 0) return@Canvas
		val gap = 2.dp.toPx()
		for (p in phrases) {
			val a = (p.startSec / durationSec).toFloat() * size.width
			val z = (p.endSec / durationSec).toFloat() * size.width
			drawRect(phraseColor(p.label), Offset(a, 0f), Size(max(0f, z - a - gap), size.height))
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
 * on release: streaming sources only seek then); pinch zooms.
 */
@Composable
fun BigWave(
	peaks: Peaks?,
	positionSec: Double,
	durationSec: Double,
	beats: FloatArray,
	downbeats: FloatArray,
	bpm: Double?,
	bars: Float,
	cues: List<Cue>,
	phrases: List<Phrase>,
	modifier: Modifier,
	onScrub: (Double) -> Unit,
	onSeek: (Double) -> Unit,
	onZoom: (Float) -> Unit,
) {
	val measurer = rememberTextMeasurer()
	val pos by rememberUpdatedState(positionSec)
	val scrub by rememberUpdatedState(onScrub)
	val seek by rememberUpdatedState(onSeek)
	val zoom by rememberUpdatedState(onZoom)
	val span = bars * 4 * beatLength(beats, bpm, positionSec)
	val spanNow by rememberUpdatedState(span)
	Box(modifier.background(C.bg1).border(1.dp, C.lineSoft)) {
		Canvas(
			Modifier
				.fillMaxSize()
				// Phrases, cue badges and the grid reach past the window's edges.
				.clipToBounds()
				.pointerInput(Unit) {
					awaitEachGesture {
						val down = awaitFirstDown()
						down.consume()
						var at = pos
						var moved = false
						var pinch: Float? = null
						while (true) {
							val ev = awaitPointerEvent()
							val pressed = ev.changes.filter { it.pressed }
							if (pressed.isEmpty()) break
							if (pressed.size >= 2) {
								val d = abs(pressed[0].position.x - pressed[1].position.x)
								val prev = pinch
								if (prev != null && d > 0) zoom(prev / d)
								pinch = d
								ev.changes.forEach { it.consume() }
								continue
							}
							val ch = pressed[0]
							val dx = ch.positionChange().x
							if (dx != 0f) {
								moved = true
								at = (at - dx / size.width * spanNow).coerceIn(0.0, durationSec.coerceAtLeast(0.0))
								scrub(at)
								ch.consume()
							}
						}
						if (moved && pinch == null) seek(at)
					}
				},
		) {
			val from = positionSec - span / 2
			val to = positionSec + span / 2
			fun x(t: Double) = ((t - from) / span).toFloat() * size.width
			// Grid: every beat line-soft, every bar fg-4 with its number.
			val bpx = 1.dp.toPx()
			for (b in beats) if (b in from..to) drawLine(C.lineSoft, Offset(x(b.toDouble()), 0f), Offset(x(b.toDouble()), size.height), bpx)
			for ((i, d) in downbeats.withIndex()) {
				if (d < from || d > to) continue
				val xx = x(d.toDouble())
				drawLine(C.fg4, Offset(xx, 0f), Offset(xx, size.height), bpx)
				val n = measurer.measure((i + 1).toString(), T.mono(10.5.sp, C.fg3))
				drawText(n, topLeft = Offset(xx + 4.dp.toPx(), 3.dp.toPx()))
			}
			drawBands(peaks, from, to, 16.dp.toPx(), size.height - 32.dp.toPx(), 3.dp.toPx())
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
				drawRect(phraseColor(p.label), Offset(x(p.startSec), size.height - lane), Size(x(p.endSec) - x(p.startSec) - 2.dp.toPx(), lane))
			}
			drawRect(Color.White, Offset(size.width / 2 - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
		}
	}
}

/** "Bar 33.1 · Build" at the playhead. */
fun readout(beats: FloatArray, downbeats: FloatArray, phrases: List<Phrase>, t: Double): String? {
	val bb = barBeat(beats, downbeats, t) ?: return null
	val phrase = phrases.firstOrNull { t >= it.startSec && t < it.endSec }?.let { " · ${phraseName(it.label)}" } ?: ""
	return "Bar ${bb.bar}.${bb.beat}$phrase"
}
