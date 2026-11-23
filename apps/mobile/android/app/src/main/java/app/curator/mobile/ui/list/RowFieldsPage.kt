package app.curator.mobile.ui.list

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Track
import app.curator.mobile.model.RowEdit
import app.curator.mobile.model.RowField
import app.curator.mobile.model.Section
import app.curator.mobile.model.Side
import app.curator.mobile.model.apply
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T

/**
 * Row fields, for all track lists (§6): pick a level, tap a section of the
 * preview, then order, remove, add or move fields into it. Every change
 * applies live and is written to `tracklist.rows`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RowFieldsPage(model: AppModel, sampleFrom: ListSource?, back: () -> Unit) {
	val rows by model.rows.collectAsState()
	val metrics by model.metrics.collectAsState()
	// A track from the list behind, one that fills most fields if it can.
	val tracks = sampleFrom?.let { rememberList(model, it) }?.tracks ?: emptyList()
	val sample = tracks.firstOrNull { it.version != null && it.tags.isNotEmpty() } ?: tracks.firstOrNull() ?: SAMPLE
	var level by rememberSaveable { mutableIntStateOf(rows.density) }
	var line by rememberSaveable { mutableIntStateOf(0) }
	var right by rememberSaveable { mutableStateOf(false) }
	val section = Section(line.coerceAtMost(level - 1), if (right) Side.R else Side.L)
	val cfg = rows.level(level)
	fun edit(e: RowEdit) = model.setRows(rows.apply(e))

	Column(
		Modifier
			.fillMaxSize()
			.background(C.bg)
			.windowInsetsPadding(WindowInsets.statusBars)
			.windowInsetsPadding(WindowInsets.navigationBars)
			.verticalScroll(rememberScrollState()),
	) {
		Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 4.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
			IconButton(Icon.Back, "Back to actions", onClick = back)
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
				BasicText("Row fields", Modifier.semantics { heading() }, style = T.of(15.sp, 500, C.fg))
				BasicText("For all track lists", style = T.of(12.5.sp, color = C.fg2))
			}
			Box(Modifier.height(44.dp).clickable(role = Role.Button, onClickLabel = "Reset this level") { edit(RowEdit.Reset(level)) }.padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
				BasicText("Reset", style = T.of(13.5.sp, color = C.fg2))
			}
		}

		Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 14.dp)) {
			Segmented(listOf("1 row", "2 rows", "3 rows"), level - 1, Role.Tab, underline = true) {
				level = it + 1
				line = 0
				right = false
			}
		}

		Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			BasicText("Preview · tap a section to edit it", Modifier.semantics { heading() }, style = T.label)
			Row(
				Modifier.fillMaxWidth().background(C.bg1).border(1.dp, C.lineSoft).padding(10.dp),
				horizontalArrangement = Arrangement.spacedBy(10.dp),
			) {
				Cover(sample.coverUrl, sample.id, mapOf(1 to 32, 2 to 44, 3 to 60).getValue(level).dp)
				Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
					for (i in 0 until level) {
						Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
							for (side in listOf(Side.L, Side.R)) {
								val s = Section(i, side)
								val fields = cfg.section(s)
								SectionBox(
									s, isSelected = s == section, empty = fields.isEmpty(),
									modifier = if (side == Side.L) Modifier.weight(1f) else Modifier.widthIn(min = 76.dp),
									onClick = { line = i; right = side == Side.R },
								) { SectionFields(fields, i, side == Side.R, sample, metrics) }
							}
						}
					}
				}
			}
		}

		val current = cfg.section(section)
		Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(verticalAlignment = Alignment.Bottom) {
				BasicText(section.label, Modifier.weight(1f).semantics { heading() }, style = T.of(15.sp, 500, C.fg))
				BasicText("${current.size} ${if (current.size == 1) "field" else "fields"}", style = T.of(12.5.sp, color = C.fg2))
			}
			BasicText("Order", Modifier.padding(top = 4.dp), style = T.label)
			Column(Modifier.topLine()) {
				if (current.isEmpty()) {
					BasicText("Nothing here yet. Pick fields below.", Modifier.height(46.dp).padding(top = 14.dp), style = T.of(13.5.sp, color = C.fg2))
				}
				for ((i, f) in current.withIndex()) {
					Row(Modifier.fillMaxWidth().height(46.dp).bottomLine(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
						BasicText("⋮⋮", Modifier.width(16.dp), style = T.of(14.sp, color = C.fg3))
						BasicText(f.label, Modifier.weight(1f), style = T.of(14.5.sp, color = C.fg))
						Square("↑", "Move ${f.label} up", enabled = i > 0) { edit(RowEdit.Reorder(level, section, i, -1)) }
						Square("↓", "Move ${f.label} down", enabled = i < current.lastIndex) { edit(RowEdit.Reorder(level, section, i, +1)) }
						Square("×", if (f == RowField.TITLE) "Title is always shown" else "Remove ${f.label}", enabled = f != RowField.TITLE) { edit(RowEdit.Remove(level, section, f)) }
					}
				}
			}
			BasicText("Fields · a field already used elsewhere moves here", Modifier.padding(top = 12.dp), style = T.label)
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
				for (f in RowField.entries) {
					val at = cfg.locate(f)
					FieldChip(f, here = at == section, elsewhere = at?.takeIf { it != section }) { edit(RowEdit.Tap(level, section, f)) }
				}
			}
		}
		Spacer(Modifier.height(24.dp))
	}
}

fun Modifier.bottomLine(): Modifier = drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }

// A section of the preview: dashed fg-4 normally, solid accent over accent-dim when selected.
@Composable
private fun SectionBox(s: Section, isSelected: Boolean, empty: Boolean, modifier: Modifier, onClick: () -> Unit, content: @Composable () -> Unit) {
	Row(
		modifier
			.defaultMinSize(minHeight = 32.dp)
			.background(if (isSelected) C.accentDim else Color.Transparent)
			.dashedBorder(if (isSelected) C.accent else C.fg4, dashed = !isSelected)
			.clickable(role = Role.Button, onClickLabel = "Edit ${s.label}", onClick = onClick)
			.semantics { selected = isSelected; contentDescription = "Edit ${s.label}" }
			.clipToBounds()
			.padding(horizontal = 6.dp, vertical = 4.dp),
		horizontalArrangement = if (s.side == Side.R) Arrangement.spacedBy(5.dp, Alignment.End) else Arrangement.spacedBy(5.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		if (empty) BasicText("Empty", style = T.of(12.sp, color = C.fg2)) else content()
	}
}

fun Modifier.dashedBorder(color: Color, dashed: Boolean): Modifier = drawBehind {
	val w = 1.dp.toPx()
	drawRect(color, topLeft = Offset(w / 2, w / 2), size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w),
		style = Stroke(w, pathEffect = if (dashed) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())) else null))
}

@Composable
private fun Square(glyph: String, label: String, enabled: Boolean, onClick: () -> Unit) {
	Box(
		Modifier
			.size(40.dp)
			.border(1.dp, C.line)
			.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
			.semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { BasicText(glyph, style = T.of(if (glyph == "×") 16.sp else 14.sp, color = if (enabled) C.fg1 else C.fg4)) }
}

// ✓ with accent: in this section (tap removes). Solid with "L2 right": used
// elsewhere (tap moves it here). Dashed: unused (tap adds it).
@Composable
private fun FieldChip(f: RowField, here: Boolean, elsewhere: Section?, onClick: () -> Unit) {
	val locked = f == RowField.TITLE && here
	val label = when {
		locked -> "Title, always shown"
		here -> "Remove ${f.label} from this section"
		elsewhere != null -> "Move ${f.label} here from line ${elsewhere.line + 1}"
		else -> "Add ${f.label} here"
	}
	Row(
		Modifier
			.height(34.dp)
			.background(if (here) C.accentDim else if (elsewhere != null) C.bg2 else Color.Transparent)
			.dashedBorder(if (here) C.accent else if (elsewhere != null) C.line else C.fg4, dashed = !here && elsewhere == null)
			.clickable(enabled = !locked, role = Role.Button, onClick = onClick)
			.semantics { contentDescription = label; selected = here }
			.padding(horizontal = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(6.dp),
	) {
		if (here) BasicText("✓", style = T.of(13.5.sp, color = C.accent))
		BasicText(f.label, style = T.of(13.5.sp, color = if (here) C.fg else C.fg1))
		elsewhere?.let { BasicText("L${it.line + 1} ${if (it.side == Side.L) "left" else "right"}", style = T.mono(11.sp, C.fg2)) }
	}
}

// When the list behind holds nothing to show, the handoff's own sample.
private val SAMPLE = Track(
	id = "sample", recordingId = null, title = "Hyperfall", version = "Original Mix", artist = "Yotto", album = "Hyperfall",
	label = "Anjunadeep", genre = "Melodic house", released = "2025", bpm = 122.0, key = "9A", durationSec = 422, rating = 4,
	power = null, brightness = null, density = null, coverUrl = null, addedAt = System.currentTimeMillis() - 12L * 86_400_000L,
	source = "spotify", tags = listOf("p3", "build"),
)
