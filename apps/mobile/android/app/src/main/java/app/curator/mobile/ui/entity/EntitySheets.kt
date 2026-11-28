package app.curator.mobile.ui.entity

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.model.ArtistReach
import app.curator.mobile.model.EntityChip
import app.curator.mobile.model.EntityHeader
import app.curator.mobile.model.EntityRef
import app.curator.mobile.model.EntitySection
import app.curator.mobile.model.EntityTab
import app.curator.mobile.model.audience
import app.curator.mobile.ui.common.BrandMark
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.brandName
import app.curator.mobile.ui.common.hasBrandMark
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Whichever sheet is up over the page, with its scrim; a tap on the scrim or back closes it. */
@Composable
internal fun EntitySheets(page: EntityPageModel, h: EntityHeader, push: (Screen) -> Unit) {
	val sheet = page.sheet ?: return
	val close = { page.sheet = null }
	Box(Modifier.fillMaxSize()) {
		Box(
			Modifier
				.fillMaxSize()
				.background(Color.Black.copy(alpha = if (sheet is EntitySheet.Menu || sheet is EntitySheet.Item) 0.55f else 0.6f))
				.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClickLabel = "Close", onClick = close),
		)
		when (sheet) {
			EntitySheet.Menu -> SourcesMenu(h, close, push)
			is EntitySheet.Item -> ItemMenu(page, sheet, close, push)
			EntitySheet.Reach -> h.reach?.let { ReachSheet(it, close) }
			EntitySheet.About -> AboutSheet(h.ref.name, close)
		}
	}
}

private class Action(val label: String, val mark: String? = null, val glyph: String? = null, val act: () -> Unit)

/** An action sheet: a quiet title, 52dp rows, Cancel apart below. */
@Composable
private fun BoxScope.ActionSheet(title: String, actions: List<Action>, close: () -> Unit) {
	Column(
		Modifier
			.align(Alignment.BottomCenter)
			.fillMaxWidth()
			.windowInsetsPadding(WindowInsets.navigationBars)
			.padding(start = 8.dp, end = 8.dp, bottom = 30.dp)
			.semantics { paneTitle = title },
		verticalArrangement = Arrangement.spacedBy(8.dp),
	) {
		Column(Modifier.fillMaxWidth().background(C.bg2).border(1.dp, C.line)) {
			BasicText(
				title,
				Modifier.fillMaxWidth().divider(C.line).padding(horizontal = 16.dp, vertical = 10.dp),
				style = T.of(12.5.sp, color = C.fg2).copy(textAlign = TextAlign.Center), maxLines = 1, overflow = TextOverflow.Ellipsis,
			)
			for (a in actions) Row(
				Modifier
					.fillMaxWidth()
					.height(52.dp)
					.divider(C.lineSoft)
					.clickable(role = Role.Button) { close(); a.act() }
					.padding(horizontal = 16.dp),
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(12.dp),
			) {
				Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
					when {
						a.mark != null && hasBrandMark(a.mark) -> BrandMark(a.mark, 22.dp)
						a.glyph != null -> BasicText(a.glyph, style = T.of(16.sp, color = C.fg2))
					}
				}
				BasicText(a.label, style = T.of(16.sp, color = C.fg), maxLines = 1, overflow = TextOverflow.Ellipsis)
			}
		}
		Box(
			Modifier.fillMaxWidth().height(52.dp).background(C.bg2).border(1.dp, C.line).clickable(role = Role.Button, onClick = close),
			contentAlignment = Alignment.Center,
		) { BasicText("Cancel", style = T.of(16.sp, 500, C.accent)) }
	}
}

private fun Modifier.divider(color: Color) = drawBehind { drawLine(color, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }

/** The hamburger: Find similar artists (artists only), then "Open in {Source}" for each store page the catalogue holds. */
@Composable
private fun BoxScope.SourcesMenu(h: EntityHeader, close: () -> Unit, push: (Screen) -> Unit) {
	val uri = LocalUriHandler.current
	val actions = buildList {
		if (!h.ref.isLabel) add(Action("Find similar artists", glyph = "≈") { push(Screen.SimilarArtists(h.ref.name, h.similar)) })
		for (l in h.links) {
			val url = l.url ?: continue
			add(Action("Open in ${brandName(l.source)}", mark = l.source, glyph = "↗") { runCatching { uri.openUri(url) } })
		}
	}
	ActionSheet(h.ref.name, actions, close)
}

/** A name's or a bar's long press: filter by it (or stop), and go to it (labels and artists; a year has no page). */
@Composable
private fun BoxScope.ItemMenu(page: EntityPageModel, item: EntitySheet.Item, close: () -> Unit, push: (Screen) -> Unit) {
	val list = if (page.tab == EntityTab.TRACKS) "tracks" else "releases"
	val on = page.filters[item.section] == item.pick
	val actions = buildList {
		add(Action("${if (on) "Stop filtering" else "Filter"} $list by ${item.pick.name}", glyph = "⌕") { page.toggleFilter(item.section, item.pick) })
		if (item.section == EntitySection.LABELS || item.section == EntitySection.ARTISTS || item.section == EntitySection.COLLABS) {
			val kind = if (item.section == EntitySection.LABELS) "label" else "artist"
			add(Action("Go to ${item.pick.name}", glyph = "→") { push(Screen.Entity(EntityRef(kind, item.pick.name, catalogId = item.pick.id))) })
		}
	}
	ActionSheet(item.pick.name, actions, close)
}

/** A bottom sheet: the grip, then [content] on bg-1 above the navigation bar. */
@Composable
private fun BoxScope.Sheet(label: String, scroll: Boolean, content: @Composable () -> Unit) {
	Column(
		Modifier
			.align(Alignment.BottomCenter)
			.fillMaxWidth()
			.heightIn(max = 640.dp)
			.background(C.bg1)
			.drawBehind { drawLine(C.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
			.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
			.then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
			.windowInsetsPadding(WindowInsets.navigationBars)
			.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 34.dp)
			.semantics { paneTitle = label },
		verticalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(C.fg4))
		content()
	}
}

@Composable
private fun Done(close: () -> Unit) {
	Box(Modifier.height(40.dp).clickable(role = Role.Button, onClick = close).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
		BasicText("Done", style = T.of(14.sp, 500, C.accent))
	}
}

private val MONTH = DateTimeFormatter.ofPattern("MMM yyyy", Locale.US)
private fun month(ms: Long): String = MONTH.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))

private fun storeDot(provider: String): Color = when (provider) {
	"spotify" -> Color(0xFF1DB954)
	"deezer" -> Color(0xFFA238FF)
	"apple" -> Color(0xFFFA243C)
	"soundcloud" -> Color(0xFFFF5500)
	"youtube" -> Color(0xFFFF0000)
	else -> C.fg
}

/** What each store said of the artist's audience, the outliers left out of the score marked as such (EntityHeader.tsx ReachMark). */
@Composable
private fun BoxScope.ReachSheet(r: ArtistReach, close: () -> Unit) {
	Sheet("Reach breakdown", scroll = true) {
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			BasicText("REACH", style = T.mono(12.sp, C.fg2).copy(letterSpacing = 1.4.sp))
			BasicText("%.1f".format(r.score), Modifier.weight(1f), style = T.mono(24.sp, C.fg, 500))
			Done(close)
		}
		r.change?.takeIf { kotlin.math.abs(it) >= 0.1 }?.let { c ->
			BasicText("${if (c > 0) "▲" else "▼"}${"%.1f".format(kotlin.math.abs(c))} over 3 months", style = T.of(13.sp, color = if (c > 0) C.buy else C.fg2))
		}
		Column(Modifier.fillMaxWidth().drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }) {
			for (p in r.parts) Row(
				Modifier.fillMaxWidth().heightIn(min = 48.dp).divider(C.lineSoft).padding(vertical = 6.dp).semantics(mergeDescendants = true) {},
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(10.dp),
			) {
				Box(Modifier.width(22.dp), contentAlignment = Alignment.CenterStart) {
					if (hasBrandMark(p.provider)) BrandMark(p.provider, 18.dp) else Box(Modifier.size(10.dp).clip(CircleShape).background(storeDot(p.provider)))
				}
				BasicText(brandName(p.provider), Modifier.weight(1f), style = T.of(14.5.sp, color = if (p.outlier) C.fg2 else C.fg))
				BasicText(audience(p.n), style = T.mono(15.sp, if (p.outlier) C.fg2 else C.fg, 500))
				Column(Modifier.width(112.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
					BasicText(p.metric.replace('_', ' '), style = T.of(12.5.sp, color = C.fg1))
					BasicText(month(p.at), style = T.of(11.5.sp, color = C.fg2))
					if (p.outlier) BasicText("Left out: the other stores disagree by over 30×", style = T.of(11.5.sp, color = C.fg2))
				}
			}
		}
		BasicText("10 × log10 of the audience, counted in Spotify listeners: 1,000 → 30 · 100K → 50 · 1M → 60", style = T.of(12.5.sp, color = C.fg2).copy(lineHeight = 18.sp))
	}
}

/**
 * What the assistant found about the artist, web-cited. Research runs on the
 * desktop and its claims stay there for now (knowledge.db; decided
 * 2026-11-26): the sheet says so, and never shows text without its sources.
 */
@Composable
private fun BoxScope.AboutSheet(name: String, close: () -> Unit) {
	Sheet("About $name", scroll = true) {
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
				BasicText("About $name", Modifier.semantics { heading() }, style = T.of(17.sp, 600, C.fg), maxLines = 2, overflow = TextOverflow.Ellipsis)
				BasicText("✦ Research by the assistant", style = T.of(12.5.sp, color = C.fg2))
			}
			Done(close)
		}
		BasicText(
			"Not on this phone yet. The assistant researches artists in Curator on your computer, and what it finds, with its sources, stays there for now.",
			style = T.of(14.sp, color = C.fg1).copy(lineHeight = 21.sp),
		)
	}
}

// ── Find similar artists ────────────────────────────────────────────────────

/** Artists like one, as the catalogue holds them: each opens its own page. */
@Composable
fun SimilarArtistsPage(of: String, artists: List<EntityChip>, back: () -> Unit, push: (Screen) -> Unit) {
	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.statusBars)) {
		Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
			IconButton(Icon.Back, "Back", onClick = back)
			BasicText("Like $of", Modifier.weight(1f).semantics { heading() }, style = T.screenTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
		}
		if (artists.isEmpty()) {
			BasicText("The catalogue has no artists like $of yet.", Modifier.padding(16.dp), style = T.secondary)
			return@Column
		}
		LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
			items(artists, key = { it.ref.catalogId ?: it.ref.name }) { a ->
				Row(
					Modifier
						.fillMaxWidth()
						.height(52.dp)
						.divider(C.lineSoft)
						.clickable(role = Role.Button) { push(Screen.Entity(a.ref)) }
						.semantics(mergeDescendants = true) { contentDescription = a.ref.name }
						.padding(horizontal = 16.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					BasicText(a.ref.name, Modifier.weight(1f), style = T.rowTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
					IconGlyph(Icon.Chevron, C.fg2, 16.dp, 1.8f)
				}
			}
		}
	}
}
