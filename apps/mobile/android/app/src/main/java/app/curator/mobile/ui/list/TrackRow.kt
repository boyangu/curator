package app.curator.mobile.ui.list

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Track
import app.curator.mobile.model.LevelConfig
import app.curator.mobile.model.RowField
import app.curator.mobile.model.StreamingService
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.TagPill
import app.curator.mobile.ui.common.formatAge
import app.curator.mobile.ui.common.formatBpm
import app.curator.mobile.ui.common.formatTime
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName

/**
 * The library's distributions of the analyzer's open-ended scores (power,
 * brightness, density): a track's value shows as its percentile in them, so
 * "0.58" means the same on every list and in the Track view's meters.
 */
@Immutable
class Metrics(private val power: DoubleArray, private val brightness: DoubleArray, private val density: DoubleArray) {
	fun power(v: Double?) = pct(power, v)
	fun brightness(v: Double?) = pct(brightness, v)
	fun density(v: Double?) = pct(density, v)

	private fun pct(sorted: DoubleArray, v: Double?): Double? {
		if (v == null || sorted.isEmpty()) return null
		var lo = 0
		var hi = sorted.size
		while (lo < hi) { val mid = (lo + hi) ushr 1; if (sorted[mid] < v) lo = mid + 1 else hi = mid }
		return lo.toDouble() / sorted.size
	}

	companion object {
		val EMPTY = Metrics(DoubleArray(0), DoubleArray(0), DoubleArray(0))
	}
}

private sealed interface Seg {
	data class Text(val text: String, val style: TextStyle, val mono: Boolean, val sepBefore: Boolean) : Seg
	data class Key(val key: String) : Seg
	data class Pill(val name: String) : Seg
}

// A row whose track isn't on the service it plays through.
private const val MISSING_ALPHA = 0.38f

// Heights, art and line gap by detail level (§6).
private val HEIGHT = mapOf(1 to 48, 2 to 60, 3 to 76)
private val ART = mapOf(1 to 32, 2 to 44, 3 to 60)

/** A row whose page is still on its way: the row's height and divider, its art's place, so nothing moves when it fills. */
@Composable
fun TrackRowPlaceholder(level: Int) {
	Row(
		Modifier
			.fillMaxWidth()
			.height(HEIGHT.getValue(level).dp)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
			.padding(horizontal = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
	) { Box(Modifier.size(ART.getValue(level).dp).background(C.bg1)) }
}

/**
 * [missingOn]: the service the track plays through when that service doesn't
 * have it (a file whose recording has no id on the one picked in Settings),
 * or can't play on this phone yet (a Tidal track).
 * The row greys out but still opens: its cues, grid and waveform are there.
 */
@Composable
fun TrackRow(track: Track, level: Int, cfg: LevelConfig, metrics: Metrics, playing: Boolean, missingOn: StreamingService?, onClick: () -> Unit) {
	val lines = cfg.lines
	Row(
		Modifier
			.fillMaxWidth()
			.height(HEIGHT.getValue(level).dp)
			.background(if (playing) C.bg1 else C.bg)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
			.clickable(role = Role.Button, onClick = onClick)
			.semantics(mergeDescendants = true) { contentDescription = describe(track, playing, missingOn) }
			// After the divider and background, so only the content dims.
			.alpha(if (missingOn != null) MISSING_ALPHA else 1f)
			.padding(horizontal = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Box(contentAlignment = Alignment.Center) {
			Cover(track.coverUrl, track.id, ART.getValue(level).dp)
			if (playing) Equaliser()
		}
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (level == 1) 0.dp else 3.dp)) {
			for (i in 0 until lines) {
				Row(Modifier.fillMaxWidth().height(if (i == 0) 20.dp else 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
					Row(Modifier.weight(1f).clipToBounds(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
						for (s in segments(cfg.l[i], i, right = false, track, metrics, playing)) Draw(s)
					}
					Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
						for (s in segments(cfg.r[i], i, right = true, track, metrics, playing)) Draw(s)
					}
				}
			}
		}
	}
}

/** One section's fields as a row draws them (the row editor's preview uses it). */
@Composable
fun RowScope.SectionFields(fields: List<RowField>, line: Int, right: Boolean, track: Track, metrics: Metrics) {
	for (s in segments(fields, line, right, track, metrics, playing = false)) Draw(s)
}

@Composable
private fun RowScope.Draw(s: Seg) {
	when (s) {
		is Seg.Text -> {
			if (s.sepBefore) BasicText("·", style = T.of(12.sp, color = C.fg4))
			BasicText(
				s.text,
				if (s.mono) Modifier else Modifier.weight(1f, fill = false),
				style = s.style, maxLines = 1, overflow = TextOverflow.Ellipsis, softWrap = false,
			)
		}
		is Seg.Key -> KeyChip(s.key)
		is Seg.Pill -> TagPill(s.name)
	}
}

// One section's fields as drawn: empty values drop out; text fields after the
// first are joined by "·", except right after the title.
private fun segments(fields: List<RowField>, line: Int, right: Boolean, t: Track, m: Metrics, playing: Boolean): List<Seg> {
	val out = mutableListOf<Seg>()
	var lastWasText = false
	var afterTitle = false
	for ((pos, f) in fields.withIndex()) {
		val isTitle = f == RowField.TITLE && line == 0 && !right && pos == 0
		val sans = if (isTitle) T.of(15.sp, color = if (playing) C.accent else C.fg) else T.of(13.sp, color = C.fg2)
		val mono = T.mono(12.5.sp, if (right && line == 0) C.fg1 else C.fg2)
		val seg: List<Seg> = when (f) {
			RowField.TITLE -> listOf(Seg.Text(t.title, if (isTitle) sans else T.of(13.sp, color = if (playing) C.accent else C.fg), false, false))
			RowField.VERSION -> t.version?.let { listOf(Seg.Text(it, sans, false, false)) }
			RowField.ARTIST -> t.artist.takeIf { it.isNotEmpty() }?.let { listOf(Seg.Text(it, sans, false, false)) }
			RowField.ALBUM -> t.album?.let { listOf(Seg.Text(it, sans, false, false)) }
			RowField.LABEL -> t.label?.let { listOf(Seg.Text(it, sans, false, false)) }
			RowField.GENRE -> t.genre?.let { listOf(Seg.Text(it, sans, false, false)) }
			RowField.RELEASED -> t.released?.take(4)?.let { listOf(Seg.Text(it, mono, true, false)) }
			RowField.ADDED -> formatAge(t.addedAt)?.let { listOf(Seg.Text("added $it", sans, false, false)) }
			RowField.BPM -> t.bpm?.let { listOf(Seg.Text(formatBpm(it), mono, true, false)) }
			RowField.KEY -> t.key?.let { listOf(Seg.Key(it)) }
			RowField.TIME -> t.durationSec?.let { listOf(Seg.Text(formatTime(it.toDouble()), mono, true, false)) }
			RowField.RATING -> t.rating?.let { listOf(Seg.Text("$it/5", mono, true, false)) }
			RowField.POWER -> m.power(t.power)?.let { listOf(Seg.Text("pwr %.2f".format(it), mono, true, false)) }
			RowField.BRIGHTNESS -> m.brightness(t.brightness)?.let { listOf(Seg.Text("brt %.2f".format(it), mono, true, false)) }
			RowField.TAGS -> t.tags.map { Seg.Pill(it) }
			RowField.SOURCE -> listOf(Seg.Text(sourceName(t.source), sans, false, false))
			RowField.OWNED -> if (t.owned) listOf(Seg.Text("Owned", T.of(13.sp, color = C.buy), false, false)) else null
		} ?: emptyList()
		for (s in seg) {
			val next = if (s is Seg.Text && lastWasText && !afterTitle && !right) s.copy(sepBefore = true) else s
			out += next
			lastWasText = s is Seg.Text
			afterTitle = isTitle
		}
	}
	return out
}

private fun describe(t: Track, playing: Boolean, missingOn: StreamingService?): String = buildString {
	if (playing) append("Now playing. ")
	missingOn?.let { append(if (it.playable) "Not on ${it.label}. " else "${it.label} playback coming soon. ") }
	append(t.title)
	t.version?.let { append(", $it") }
	if (t.artist.isNotEmpty()) append(", by ${t.artist}")
	t.bpm?.let { append(", ${formatBpm(it)} BPM") }
	t.key?.let { append(", key $it") }
}

/** The now-playing mark on a row's art: four accent bars. */
@Composable
private fun Equaliser() {
	Canvas(Modifier.size(16.dp, 12.dp)) {
		val w = size.width / 16f
		val h = size.height / 12f
		for ((x, top) in listOf(0f to 4f, 4.3f to 0f, 8.6f to 6f, 13f to 2f)) {
			drawRect(C.accent, Offset(x * w, top * h), Size(3f * w, (12f - top) * h))
		}
	}
}
