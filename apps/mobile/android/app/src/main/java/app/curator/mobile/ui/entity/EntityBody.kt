package app.curator.mobile.ui.entity

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.model.EntityHeader
import app.curator.mobile.model.EntityRef
import app.curator.mobile.model.EntityRelease
import app.curator.mobile.model.EntityRow
import app.curator.mobile.model.Item
import app.curator.mobile.model.Pick
import app.curator.mobile.model.Scope
import app.curator.mobile.model.EntitySection
import app.curator.mobile.model.activeRange
import app.curator.mobile.model.bars
import app.curator.mobile.model.coverageText
import app.curator.mobile.model.moreStep
import app.curator.mobile.model.noLocalText
import app.curator.mobile.model.releaseLabel
import app.curator.mobile.model.sectionItems
import app.curator.mobile.model.shownCount
import app.curator.mobile.model.tabCounts
import app.curator.mobile.model.worldOffText
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.formatTime
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val SELECTED_FILL = C.accent.copy(alpha = 0.28f)
private val BAR_FILL = Color(0xFF26262D)
// The canvas's 16-unit icons: three left-aligned bars ("as a chart"), two offset pills ("as names").
private const val BARS = "M2 3.5h12M2 8h8.5M2 12.5h5"
private const val PILLS = "M3.75 2.5h3.5a2.25 2.25 0 0 1 0 4.5h-3.5a2.25 2.25 0 0 1 0-4.5zM8.75 9h3.5a2.25 2.25 0 0 1 0 4.5h-3.5a2.25 2.25 0 0 1 0-4.5z"

@Composable
internal fun EntityList(model: AppModel, page: EntityPageModel, h: EntityHeader, list: LazyListState, y: State<Float>, push: (Screen) -> Unit) {
	val releases = page.releases()
	val tracks = page.tracks(releases)
	val world = page.scope == Scope.WORLD
	val listWord = if (page.tab == EntityTab.TRACKS) "tracks" else "releases"
	val scope = rememberCoroutineScope()
	// A library track opens its player; a catalogue one plays as the feed's do.
	val play: (EntityRow) -> Unit = { r ->
		val id = r.libraryTrackId
		val lib = model.library.value
		if (id != null && lib != null) scope.launch {
			val t = withContext(Dispatchers.IO) { lib.track(id) } ?: return@launch
			model.open(t, start = true)
			push(Screen.Track(id, null, 0, 1))
		} else page.playCatalogue(r)
	}

	LazyColumn(Modifier.fillMaxWidth(), state = list) {
		item("hero", contentType = "hero") { Hero(page, h, y) }
		item("attributes", contentType = "attributes") { Attributes(page, h, push) }
		item("status", contentType = "status") { Status(page, h, push) }
		item("switch", contentType = "switch") { ListSwitch(page, h) }
		if (page.filters.isNotEmpty()) item("filtered", contentType = "filtered") {
			Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 10.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
				BasicText("Filtered list of $listWord", Modifier.weight(1f), style = T.secondary)
				Box(
					Modifier.height(30.dp).border(1.dp, C.line).clickable(role = Role.Button, onClickLabel = "Clear the filters", onClick = page::clearFilters).padding(horizontal = 12.dp),
					contentAlignment = Alignment.Center,
				) { BasicText("Clear", style = T.of(13.sp, color = C.fg)) }
			}
		}
		item("rule", contentType = "rule") { Rule() }
		if (page.tab == EntityTab.RELEASES) {
			itemsIndexed(releases, key = { _, r -> "r:${r.id}" }, contentType = { _, _ -> "release" }) { i, r ->
				ReleaseRow(r, page.isOpen(i, r.id), showTag = world, onToggle = { page.toggleOpen(i, r.id) }, play = play)
			}
		} else {
			items(tracks, key = { "t:${it.id}" }, contentType = { "track" }) { r -> TrackRow(r, withCover = true, showTag = world) { play(r) } }
		}
		val empty = if (page.tab == EntityTab.RELEASES) releases.isEmpty() else tracks.isEmpty()
		if (empty && page.filters.isNotEmpty()) item("none", contentType = "note") { Note("No $listWord match the current selection.") }
		if (world && page.hasMore) item("more", contentType = "more") {
			// In view: the next page is asked for (the Active chart grows with it).
			LaunchedEffect(page.pages.size) { page.more() }
			Note(if (page.worldError == null) "Loading…" else null)
		}
		if (world && page.worldError != null) item("error", contentType = "note") {
			Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
				BasicText(page.worldError!!, style = T.secondary)
				SmallButton("Try again", page::more)
			}
		}
	}
}

@Composable
private fun Rule() {
	Box(Modifier.fillMaxWidth().height(1.dp).background(C.lineSoft))
}

@Composable
private fun Note(text: String?) {
	Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 28.dp), contentAlignment = Alignment.Center) {
		text?.let { BasicText(it, style = T.of(14.sp, color = C.fg2)) }
	}
}

@Composable
private fun SmallButton(text: String, onClick: () -> Unit) {
	Box(Modifier.height(30.dp).border(1.dp, C.line).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
		BasicText(text, style = T.of(13.sp, color = C.fg))
	}
}

// ── attributes ──────────────────────────────────────────────────────────────

@Composable
private fun Attributes(page: EntityPageModel, h: EntityHeader, push: (Screen) -> Unit) {
	// What an artist or a label IS comes from the catalogue, in either scope.
	val releases = page.worldReleases
	Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
		for (s in EntitySection.of(h.ref.kind)) {
			val items = sectionItems(s, h, releases)
			val range = if (s == EntitySection.ACTIVE) activeRange(h.activity, releases) else null
			if (items.isEmpty() && range == null) continue
			AttributeSection(page, s, items, range, push)
		}
	}
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttributeSection(page: EntityPageModel, s: EntitySection, items: List<Item>, range: String?, push: (Screen) -> Unit) {
	val chart = s in page.charts && items.isNotEmpty()
	val shown = shownCount(s, items.size, page.steps[s] ?: 0)
	val more = moreStep(items.size, shown)
	Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
		Row(Modifier.heightIn(min = 24.dp), verticalAlignment = Alignment.CenterVertically) {
			BasicText(s.title, Modifier.weight(1f).semantics { heading() }, style = T.label)
			if (s.chartable && items.isNotEmpty()) {
				val label = if (chart) "Show ${s.title} as names and clear its filter" else "Show ${s.title} as a chart"
				Box(
					Modifier
						.width(36.dp)
						.height(30.dp)
						.clickable(role = Role.Button, onClickLabel = label) { page.toggleChart(s) }
						.semantics { contentDescription = label },
					contentAlignment = Alignment.Center,
				) { if (chart) Glyph(PILLS, 16f, C.fg1, 16.dp, 1.6f) else Glyph(BARS, 16f, C.fg1, 16.dp, 2f) }
			}
		}
		val goes = s == EntitySection.LABELS || s == EntitySection.ARTISTS || s == EntitySection.COLLABS
		val open: (Pick) -> Unit = { p -> push(Screen.Entity(EntityRef(if (s == EntitySection.LABELS) "label" else "artist", p.name, catalogId = p.id))) }
		val menu: (Pick) -> Unit = { p -> page.sheet = EntitySheet.Item(s, p) }
		when {
			chart -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
				for ((item, share) in bars(items.take(shown))) Bar(item, share, page.filters[s] == item.pick, onTap = { page.toggleFilter(s, item.pick) }, onLong = { menu(item.pick) })
				if (more > 0) ShowMore(more, 30.dp, 13f) { page.showMore(s) }
			}
			range != null -> BasicText(range, style = T.of(14.5.sp, color = C.fg))
			else -> FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
				for (item in items.take(shown)) {
					if (s.chartable) Name(item, page.filters[s] == item.pick, onTap = if (goes) ({ open(item.pick) }) else null, onLong = { menu(item.pick) })
					else BasicText(item.pick.name, style = T.of(14.5.sp, color = C.fg))
				}
				if (more > 0) ShowMore(more, null, 14.5f) { page.showMore(s) }
			}
		}
	}
}

/** A name with its count: tap goes to it, a long press (with a buzz) opens its menu; both are TalkBack actions. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Name(item: Item, filtered: Boolean, onTap: (() -> Unit)?, onLong: () -> Unit) {
	val haptics = LocalHapticFeedback.current
	BasicText(
		buildAnnotatedString {
			append(item.pick.name)
			if (item.count > 0) withStyle(SpanStyle(fontFamily = T.mono(12.sp).fontFamily, fontSize = 12.sp, color = C.fg2)) { append(" (${item.count})") }
		},
		Modifier.combinedClickable(
			role = Role.Button,
			onClickLabel = onTap?.let { "Go to ${item.pick.name}" },
			onLongClickLabel = "Options",
			onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); onLong() },
			onClick = { onTap?.invoke() },
		),
		style = T.of(14.5.sp, color = if (filtered) C.accent else C.fg),
	)
}

/** One bar of a section's chart: its share of the largest, the name and count over it. Tap filters; long press opens its menu. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Bar(item: Item, share: Float, on: Boolean, onTap: () -> Unit, onLong: () -> Unit) {
	val haptics = LocalHapticFeedback.current
	Row(
		Modifier
			.fillMaxWidth()
			.height(26.dp)
			.background(C.bg2)
			.drawBehind {
				val w = size.width * share
				drawRect(if (on) SELECTED_FILL else BAR_FILL, size = Size(w, size.height))
				val edge = 2.dp.toPx()
				if (w >= edge) drawRect(if (on) C.accent else C.fg2, Offset(w - edge, 0f), Size(edge, size.height))
			}
			.combinedClickable(
				role = Role.Button,
				onClickLabel = if (on) "Stop filtering" else "Filter",
				onLongClickLabel = "Options",
				onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); onLong() },
				onClick = onTap,
			)
			.semantics { selected = on; if (on) stateDescription = "Filtering" }
			.padding(horizontal = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		BasicText(item.pick.name, Modifier.weight(1f), style = T.of(13.sp, color = C.fg), maxLines = 1, overflow = TextOverflow.Ellipsis)
		BasicText(item.count.toString(), style = T.mono(12.5.sp, C.fg))
	}
}

/** "Show 5 more", underlined with dots. */
@Composable
private fun ShowMore(n: Int, height: androidx.compose.ui.unit.Dp?, fontSize: Float, onClick: () -> Unit) {
	BasicText(
		"Show $n more",
		Modifier
			.then(if (height != null) Modifier.height(height) else Modifier)
			.clickable(role = Role.Button, onClick = onClick)
			.drawBehind {
				val y = size.height - 1.dp.toPx()
				drawLine(C.fg2, Offset(0f, y), Offset(size.width, y), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(1.5.dp.toPx(), 2.dp.toPx())))
			}
			.padding(bottom = 3.dp),
		style = T.of(fontSize.sp, color = C.fg2),
	)
}

// ── the status lines ────────────────────────────────────────────────────────

@Composable
private fun Status(page: EntityPageModel, h: EntityHeader, push: (Screen) -> Unit) {
	val lines = mutableListOf<String>()
	val kind = h.ref.kind
	if (page.scope == Scope.OWNED) {
		if (page.owned?.isEmpty() == true) lines += noLocalText(kind)
	} else if (!h.world.available) {
		worldOffText(h.world.reason, kind)?.let { lines += it }
	} else {
		val loaded = page.worldReleases
		coverageText(loaded.sumOf { it.tracks.size }, loaded.size, h.world.releaseCount, page.hasMore)?.let { lines += it }
	}
	val candidates = if (page.scope == Scope.WORLD && h.world.reason == "ambiguous") h.world.candidates else emptyList()
	if (lines.isEmpty() && !page.failed) return
	Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		if (page.failed) {
			BasicText("This page could not be read.", style = T.secondary)
			SmallButton("Try again", page::retry)
		}
		for (l in lines) BasicText(l, style = T.secondary)
		for (c in candidates) BasicText(
			c.ref.name,
			Modifier.clickable(role = Role.Button) { push(Screen.Entity(c.ref)) }.padding(vertical = 6.dp),
			style = T.of(14.5.sp, color = C.accent),
		)
	}
}

// ── Releases / Tracks ───────────────────────────────────────────────────────

@Composable
private fun ListSwitch(page: EntityPageModel, h: EntityHeader) {
	val counts = tabCounts(page.scope, h.world, page.owned)
	Column(Modifier.padding(top = 16.dp)) {
		Rule()
		Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			Row(Modifier.weight(1f).height(36.dp).border(1.dp, C.line)) {
				Segment("Releases", counts.first, page.tab == EntityTab.RELEASES, first = true) { page.tab = EntityTab.RELEASES }
				Segment("Tracks", counts.second, page.tab == EntityTab.TRACKS, first = false) { page.tab = EntityTab.TRACKS }
			}
			// The one order for now: released, newest first.
			Row(
				Modifier.height(36.dp).border(1.dp, C.line).padding(horizontal = 10.dp).semantics(mergeDescendants = true) { contentDescription = "Sorted by release date, newest first" },
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(4.dp),
			) {
				BasicText("Released", style = T.of(13.sp, color = C.fg1))
				BasicText("↓", style = T.of(13.sp, color = C.accent))
			}
		}
	}
}

@Composable
private fun RowScope.Segment(label: String, count: Int?, on: Boolean, first: Boolean, onClick: () -> Unit) {
	Box(
		Modifier
			.weight(1f)
			.fillMaxHeight()
			.background(if (on) C.accentDim else Color.Transparent)
			.drawBehind {
				if (!first) drawLine(C.line, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
				if (on) drawRect(C.accent, Offset(0f, size.height - 2.dp.toPx()), Size(size.width, 2.dp.toPx()))
			}
			.clickable(role = Role.Tab, onClick = onClick)
			.semantics { selected = on },
		contentAlignment = Alignment.Center,
	) {
		BasicText(
			buildAnnotatedString {
				append(label)
				count?.let { withStyle(SpanStyle(fontFamily = T.mono(11.5.sp).fontFamily, fontSize = 11.5.sp, color = C.fg2)) { append(" $it") } }
			},
			style = T.of(13.5.sp, color = if (on) C.fg else C.fg1),
		)
	}
}

/** A release: cover, title, "artists · date", "label · genre"; key, BPM and length at the right. A tap opens or closes its tracks. */
@Composable
private fun ReleaseRow(r: EntityRelease, open: Boolean, showTag: Boolean, onToggle: () -> Unit, play: (EntityRow) -> Unit) {
	Column(Modifier.fillMaxWidth().drawBehind { drawLine(C.lineSoft, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }) {
		Row(
			Modifier
				.fillMaxWidth()
				.clickable(role = Role.Button, onClickLabel = if (open) "Hide its tracks" else "Show its tracks", onClick = onToggle)
				.semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
				.padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Cover(r.coverUrl, r.id, 64.dp)
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
				BasicText(r.title, style = T.of(15.5.sp, 600, C.fg), maxLines = 1, overflow = TextOverflow.Ellipsis)
				val by = listOfNotNull(r.artists.joinToString(", ") { it.name }.takeIf { it.isNotEmpty() }, releaseLabel(r.date)).joinToString(" · ")
				if (by.isNotEmpty()) BasicText(by, style = T.of(13.sp, color = C.fg2), maxLines = 1, overflow = TextOverflow.Ellipsis)
				val meta = listOfNotNull(r.label?.name, r.genre).joinToString(" · ")
				if (meta.isNotEmpty()) BasicText(meta, style = T.of(13.sp, color = C.fg1), maxLines = 1, overflow = TextOverflow.Ellipsis)
			}
			Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
				r.key?.let { KeyChip(it) }
				r.bpmText?.let { BasicText(it, style = T.mono(12.sp, C.fg)) }
				val n = maxOf(r.trackCount, r.tracks.size)
				val length = r.seconds.takeIf { it > 0 }?.let { " · ${formatTime(it)}" } ?: ""
				BasicText("$n ${if (n == 1) "track" else "tracks"}$length", style = T.mono(12.sp, C.fg2))
			}
			IconGlyph(Icon.Caret, C.fg2, 16.dp, 1.8f, Modifier.rotate(if (open) 180f else 0f))
		}
		if (open && r.tracks.isNotEmpty()) Column(Modifier.fillMaxWidth().background(C.bg1)) {
			Rule()
			for (t in r.tracks) TrackRow(t, withCover = false, showTag = showTag) { play(t) }
		}
	}
}

/**
 * A track (canvas EntityTrack.dc.html): title with its version and the In
 * Library tag over its artists; length over BPM and key at the right. No
 * source dots, no track numbers. A catalogue row with nowhere to play dims.
 */
@Composable
private fun TrackRow(r: EntityRow, withCover: Boolean, showTag: Boolean, onClick: () -> Unit) {
	val playable = r.inLibrary || r.spotifyId != null
	Row(
		Modifier
			.fillMaxWidth()
			.defaultMinSize(minHeight = 60.dp)
			.alpha(if (playable) 1f else 0.38f)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }
			.clickable(enabled = playable, role = Role.Button, onClickLabel = "Play", onClick = onClick)
			.semantics(mergeDescendants = true) {
				contentDescription = buildString {
					append(r.title)
					r.version?.let { append(" $it") }
					if (r.artistLine.isNotEmpty()) append(" by ${r.artistLine}")
					if (showTag && r.inLibrary) append(", in library")
					r.durationSec?.let { append(", ${formatTime(it)}") }
					r.bpm?.let { append(", ${Math.round(it)} BPM") }
					r.key?.let { append(", key ${it.uppercase()}") }
				}
			}
			.padding(horizontal = 16.dp, vertical = 9.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		if (withCover) Cover(r.coverUrl, r.id, 44.dp)
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				BasicText(
					buildAnnotatedString {
						append(r.title)
						r.version?.let { withStyle(SpanStyle(color = C.fg2)) { append(" $it") } }
					},
					Modifier.weight(1f, fill = false), style = T.of(14.5.sp, color = C.fg), maxLines = 1, overflow = TextOverflow.Ellipsis,
				)
				if (showTag && r.inLibrary) InLibraryTag()
			}
			BasicText(r.artistLine, style = T.of(12.5.sp, color = C.fg2), maxLines = 1, overflow = TextOverflow.Ellipsis)
		}
		Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
			BasicText(r.durationSec?.let(::formatTime) ?: "", style = T.mono(12.5.sp, C.fg2))
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				BasicText(r.bpm?.let { Math.round(it).toString() } ?: "—", style = T.mono(12.5.sp, if (r.bpm != null) C.fg else C.fg4))
				KeyChip(r.key)
			}
		}
	}
}

/** The feed ribbon's look: solid buy-green, black text, square corners. */
@Composable
private fun InLibraryTag() {
	Box(Modifier.height(17.dp).background(C.buy).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
		BasicText("In Library", style = T.of(11.sp, 600, Color.Black))
	}
}
