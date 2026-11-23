package app.curator.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.keyChipColor
import app.curator.mobile.ui.theme.sourceColor

/** An icon-only button: a 44dp target, always labelled for TalkBack. */
@Composable
fun IconButton(icon: Icon, label: String, tint: Color = C.fg1, size: Dp = 22.dp, modifier: Modifier = Modifier, onClick: () -> Unit) {
	Box(
		modifier
			.size(44.dp)
			.clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
			.semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { IconGlyph(icon, tint, size) }
}

/** Text in one line, ellipsised. */
@Composable
fun Line(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier) {
	BasicText(text, modifier, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** The Camelot key chip: black mono text on the key's hue; 18dp high in rows, 22 in the track header. */
@Composable
fun KeyChip(key: String?, height: Dp = 18.dp, fontSize: Float = 12f, modifier: Modifier = Modifier) {
	val bg = keyChipColor(key) ?: return
	Box(
		modifier
			.defaultMinSize(minWidth = if (height > 18.dp) 34.dp else 30.dp)
			.height(height)
			.clip(RoundedCornerShape(3.dp))
			.background(bg)
			.padding(horizontal = 4.dp)
			.semantics { contentDescription = "Key ${key!!.uppercase()}" },
		contentAlignment = Alignment.Center,
	) { BasicText(key!!.uppercase(), style = T.mono(fontSize.sp, Color.Black)) }
}

/** A tag pill. */
@Composable
fun TagPill(name: String, height: Dp = 20.dp, modifier: Modifier = Modifier) {
	Box(
		modifier
			.height(height)
			.clip(RoundedCornerShape(8.dp))
			.background(C.bg2)
			.border(1.dp, C.line, RoundedCornerShape(8.dp))
			.padding(horizontal = if (height > 20.dp) 10.dp else 7.dp),
		contentAlignment = Alignment.Center,
	) { BasicText(name, style = T.of(if (height > 20.dp) 12.5.sp else 12.sp, color = if (height > 20.dp) C.fg1 else C.fg2), maxLines = 1) }
}

@Composable
fun SourceDot(source: String?, modifier: Modifier = Modifier) {
	Box(modifier.size(6.dp).clip(CircleShape).background(sourceColor(source)))
}

/** The 40×24 switch: accent with a black knob when on. Its row owns the toggle and the semantics. */
@Composable
fun SwitchTrack(on: Boolean) {
	Box(Modifier.width(40.dp).height(24.dp).clip(RoundedCornerShape(12.dp)).background(if (on) C.accent else C.line)) {
		Box(
			Modifier
				.offset(x = if (on) 19.dp else 3.dp, y = 3.dp)
				.size(18.dp)
				.clip(CircleShape)
				.background(if (on) Color.Black else C.fg2),
		)
	}
}

/** A full-width row with a switch, the row itself the toggle (TalkBack reads its state). */
@Composable
fun SwitchRow(label: String, on: Boolean, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null, onToggle: () -> Unit) {
	Row(
		modifier
			.clickable(role = Role.Switch, onClick = onToggle)
			.semantics(mergeDescendants = true) {
				toggleableState = if (on) ToggleableState.On else ToggleableState.Off
				stateDescription = if (on) "On" else "Off"
			}
			.padding(horizontal = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		leading?.invoke()
		BasicText(label, Modifier.weight(1f), style = T.of(15.sp, color = C.fg))
		SwitchTrack(on)
	}
}

/** A chip: square-ish (radius 4), accent border and dim fill when selected. */
@Composable
fun Chip(
	label: String,
	selected: Boolean,
	modifier: Modifier = Modifier,
	height: Dp = 28.dp,
	radius: Dp = 4.dp,
	mono: Boolean = false,
	onClick: () -> Unit,
) {
	val shape = RoundedCornerShape(radius)
	Box(
		modifier
			.height(height)
			.clip(shape)
			.background(if (selected) C.accentDim else Color.Transparent)
			.border(1.dp, if (selected) C.accent else C.line, shape)
			.clickable(role = Role.Button, onClick = onClick)
			.semantics { toggleableState = if (selected) ToggleableState.On else ToggleableState.Off }
			.padding(horizontal = 8.dp),
		contentAlignment = Alignment.Center,
	) {
		val color = if (selected) C.fg else C.fg1
		BasicText(label, style = if (mono) T.mono(12.5.sp, color) else T.of(12.sp, color = color), maxLines = 1)
	}
}

fun formatTime(sec: Double?): String {
	if (sec == null || sec.isNaN()) return "–:––"
	val s = sec.toInt().coerceAtLeast(0)
	return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

fun formatBpm(bpm: Double?, decimals: Int = 0): String =
	if (bpm == null) "–" else if (decimals == 0) "%.0f".format(bpm) else "%.${decimals}f".format(bpm)

/** "1 h 52 m", "38 m". */
fun formatDuration(sec: Long): String {
	val m = (sec / 60).toInt()
	return if (m >= 60) "${m / 60} h ${m % 60} m" else "$m m"
}

/** "2 h ago", "Yesterday", "Thu", "12 Oct": when a playlist was last opened here. */
fun formatWhen(ms: Long, now: Long = System.currentTimeMillis()): String {
	val d = now - ms
	val hour = 3_600_000L
	val day = 24 * hour
	return when {
		d < hour -> "Just now"
		d < day -> "${d / hour} h ago"
		d < 2 * day -> "Yesterday"
		d < 7 * day -> java.text.SimpleDateFormat("EEE", java.util.Locale.getDefault()).format(java.util.Date(ms))
		else -> java.text.SimpleDateFormat("d MMM", java.util.Locale.getDefault()).format(java.util.Date(ms))
	}
}

/** "12 days", "3 months": how long ago a track was added. */
fun formatAge(ms: Long?, now: Long = System.currentTimeMillis()): String? {
	if (ms == null) return null
	val days = ((now - ms) / 86_400_000L).coerceAtLeast(0)
	return when {
		days < 1 -> "today"
		days < 60 -> "$days ${if (days == 1L) "day" else "days"}"
		days < 730 -> "${days / 30} months"
		else -> "${days / 365} years"
	}
}
