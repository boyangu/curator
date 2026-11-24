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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.ListQuery
import app.curator.mobile.model.BpmBucket
import app.curator.mobile.model.ListView
import app.curator.mobile.model.Sort
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.SwitchRow
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ListActionsPage(model: AppModel, source: ListSource, back: () -> Unit, openFields: () -> Unit) {
	val info = rememberListInfo(model, source)
	val view = rememberView(model, source) ?: ListView()
	// The list's own pager (the same query, so the same counts as the list behind).
	val pager = rememberPager(model, ListQuery(source.scope(), view))
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val tagChoices by produceState(emptyList<String>(), lib, version, source) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { l.tagNames(ListQuery(source.scope(), ListView()).tagCounts()) }
	}
	val pins by model.pins.collectAsState()
	val rows by model.rows.collectAsState()
	val scope = rememberCoroutineScope()
	fun set(v: ListView) = scope.launch { model.viewState.setListView(source.key, v) }
	val pin = info?.pin
	val pinned = pin != null && pin in pins

	Column(
		Modifier
			.fillMaxSize()
			.background(C.bg)
			.windowInsetsPadding(WindowInsets.statusBars)
			.windowInsetsPadding(WindowInsets.navigationBars)
			.verticalScroll(rememberScrollState()),
	) {
		Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 4.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
			IconButton(Icon.Back, "Back to the list", onClick = back)
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
				Line(info?.name ?: "", T.of(15.sp, 500, C.fg))
				val total = pager?.totals?.count
				BasicText(if (pager?.complete == true && total != null) "Showing ${pager.size} of $total" else "", style = T.of(12.5.sp, color = C.fg2))
			}
			Box(Modifier.height(44.dp).clickable(role = Role.Button, enabled = view.filtered) { set(view.cleared()) }.padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
				BasicText("Clear filters", style = T.of(13.sp, color = if (view.filtered) C.fg2 else C.fg3))
			}
		}

		if (pin != null) SwitchRow(
			if (pinned) "Pinned to Home" else "Pin to Home", pinned,
			Modifier.fillMaxWidth().height(52.dp).topLine(),
			leading = { IconGlyph(Icon.Pin, if (pinned) C.accent else C.fg2, 18.dp, 1.6f) },
		) { model.togglePin(pin) }

		Section("Sort · tap again to flip") {
			for (line in Sort.entries.chunked(3)) {
				Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
					for (s in line) {
						val on = s == view.sort
						Option(Modifier.weight(1f), on, 40.dp, onClick = { set(view.pick(s)) }) {
							BasicText(s.label, style = T.of(13.5.sp, color = if (on) C.fg else C.fg1))
							if (on && s != Sort.CUSTOM) BasicText(if (view.dir > 0) " ↑" else " ↓", style = T.mono(12.sp, C.accent))
						}
					}
				}
			}
		}

		Section("Filter by tag") {
			val tags = tagChoices
			if (tags.isEmpty()) BasicText("No tags in this list.", style = T.secondary)
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
				for (t in tags) {
					val on = t in view.tags
					Box(
						Modifier
							.height(34.dp)
							.background(if (on) C.accentDim else C.bg2, RoundedCornerShape(8.dp))
							.border(1.dp, if (on) C.accent else C.line, RoundedCornerShape(8.dp))
							.clickable(role = Role.Checkbox) { set(view.copy(tags = if (on) view.tags - t else view.tags + t)) }
							.semantics { toggleableState = if (on) ToggleableState.On else ToggleableState.Off }
							.padding(horizontal = 12.dp),
						contentAlignment = Alignment.Center,
					) { BasicText(t, style = T.of(13.5.sp, color = if (on) C.fg else C.fg1)) }
				}
			}
			BasicText("BPM", Modifier.padding(top = 6.dp).semantics { heading() }, style = T.label)
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (b in BpmBucket.entries) {
					val on = b == view.bpm
					Option(Modifier.weight(1f), on, 34.dp, role = Role.RadioButton, onClick = { set(view.copy(bpm = b)) }) {
						BasicText(b.label, style = T.mono(12.5.sp, if (on) C.fg else C.fg1))
					}
				}
			}
		}
		SwitchRow("Owned files only", view.ownedOnly, Modifier.fillMaxWidth().height(48.dp)) { set(view.copy(ownedOnly = !view.ownedOnly)) }

		Column(Modifier.fillMaxWidth().topLine().padding(16.dp, 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				BasicText("Row detail · all track lists", Modifier.weight(1f).semantics { heading() }, style = T.label)
				Row(
					Modifier.height(36.dp).clickable(role = Role.Button, onClickLabel = "Edit row fields", onClick = openFields).padding(start = 12.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					BasicText("Edit", style = T.of(14.sp, color = C.accent))
					IconGlyph(Icon.Chevron, C.accent, 14.dp, 2f)
				}
			}
			Segmented(listOf("1 row", "2 rows", "3 rows"), rows.density - 1, Role.RadioButton) { model.setRows(rows.copy(density = it + 1)) }
		}
		Spacer(Modifier.height(24.dp))
	}
}

fun Modifier.topLine(): Modifier = drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }

@Composable
private fun Section(label: String, content: @Composable () -> Unit) {
	Column(Modifier.fillMaxWidth().topLine().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		BasicText(label, Modifier.semantics { heading() }, style = T.label)
		content()
	}
}

/** A square option: accent-dim fill and accent border when chosen. */
@Composable
fun Option(modifier: Modifier, on: Boolean, height: Dp, role: Role = Role.Button, onClick: () -> Unit, content: @Composable () -> Unit) {
	Row(
		modifier
			.height(height)
			.background(if (on) C.accentDim else Color.Transparent)
			.border(1.dp, if (on) C.accent else C.line)
			.clickable(role = role, onClick = onClick)
			.semantics { selected = on },
		horizontalArrangement = Arrangement.Center,
		verticalAlignment = Alignment.CenterVertically,
	) { content() }
}

/** A row of equal options in one 1dp frame (row detail, the editor's level tabs). */
@Composable
fun Segmented(labels: List<String>, selectedIndex: Int, role: Role, underline: Boolean = false, onSelect: (Int) -> Unit) {
	Row(Modifier.fillMaxWidth().height(40.dp).border(1.dp, C.line)) {
		for ((i, l) in labels.withIndex()) {
			val on = i == selectedIndex
			Box(
				Modifier
					.weight(1f)
					.fillMaxHeight()
					.drawBehind {
						if (i > 0) drawLine(C.line, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
						if (on && underline) drawLine(C.accent, Offset(0f, size.height - 1.dp.toPx()), Offset(size.width, size.height - 1.dp.toPx()), 2.dp.toPx())
					}
					.background(if (on) C.accentDim else Color.Transparent)
					.clickable(role = role) { onSelect(i) }
					.semantics { selected = on },
				contentAlignment = Alignment.Center,
			) { BasicText(l, style = T.of(13.5.sp, color = if (on) C.fg else C.fg1)) }
		}
	}
}
