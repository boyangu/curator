package app.curator.mobile.ui.track

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.ArtistRef
import app.curator.mobile.data.PlaylistSummary
import app.curator.mobile.data.SetSummary
import app.curator.mobile.data.Track
import app.curator.mobile.data.TrackAnalysis
import app.curator.mobile.model.CoverBands
import app.curator.mobile.model.Peaks
import app.curator.mobile.model.Score
import app.curator.mobile.model.SheetDrag
import app.curator.mobile.model.WaveSkin
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.CoverFill
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.common.TagPill
import app.curator.mobile.ui.common.formatTime
import app.curator.mobile.ui.nav.LocalSheetGestures
import app.curator.mobile.ui.nav.SheetGestures
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.oklch
import app.curator.mobile.ui.theme.sourceName
import kotlin.math.abs

/** Where the open track is used: the playlists holding it and the sets it was played in. */
internal class Uses(val playlists: List<PlaylistSummary>, val sets: List<SetSummary>)

/** The people under the player: the credited artists (each its library page) and the label. */
internal class People(val artists: List<ArtistRef>, val label: String?, val artistPicture: (String) -> String?, val labelPicture: (String) -> String?)

/**
 * The player, upright: the cover with its facts on it, the overview with
 * the time, the controls, then everything below in one scroll (Analysis,
 * Tags, where it is used, who made it). It is a sheet: the grip, a tap on it
 * or a pull down from the top of the scroll lowers it to the mini bar.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Portrait(
	t: Track, bands: CoverBands, a: TrackAnalysis, peaks: Peaks?, skin: WaveSkin, position: () -> Double, duration: Double, tr: Transport,
	scores: List<Score>, uses: Uses?, people: People, playingFrom: String?,
	from: String?, index: Int, count: Int,
	back: () -> Unit, openActions: () -> Unit, openUses: (sets: Boolean) -> Unit, openArtist: (ArtistRef) -> Unit, openLabel: (String) -> Unit,
	onScrub: (Double) -> Unit, onCallOff: () -> Unit, onSeek: (Double) -> Unit, modifier: Modifier,
) {
	val sheet = LocalSheetGestures.current
	Column(
		modifier
			.fillMaxSize()
			.background(C.bg)
			.windowInsetsPadding(WindowInsets.statusBars)
			.semantics { customActions = listOf(CustomAccessibilityAction("Collapse player") { back(); true }) },
	) {
		Box(Modifier.fillMaxWidth().height(56.dp)) {
			Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(48.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
				IconButton(Icon.Back, if (from != null) "Back to $from" else "Back", onClick = back)
				BasicText(
					buildAnnotatedString {
						if (from != null) {
							append("From ")
							withStyle(SpanStyle(color = C.fg)) { append(from) }
							append(" · ${index + 1} of $count")
						}
					},
					Modifier.weight(1f), style = T.of(13.sp, color = C.fg2).copy(textAlign = TextAlign.Center), maxLines = 1, overflow = TextOverflow.Ellipsis,
				)
				IconButton(Icon.Menu, "Track actions", tint = C.fg, onClick = openActions)
			}
			// The grip, its target kept clear of Back and the menu.
			Box(
				Modifier
					.align(Alignment.TopCenter)
					.padding(horizontal = 96.dp)
					.fillMaxWidth()
					.height(44.dp)
					.then(if (sheet != null) Modifier.gripDrag(sheet, back) else Modifier)
					.semantics { contentDescription = "Collapse player"; role = Role.Button; onClick { back(); true } },
			) { Box(Modifier.align(Alignment.TopCenter).padding(top = 4.dp).size(40.dp, 5.dp).background(C.fg3, RoundedCornerShape(3.dp))) }
		}
		val scroll = rememberScrollState()
		Column(
			Modifier
				.weight(1f)
				.then(if (sheet != null) Modifier.pullToClose(sheet, scroll) else Modifier)
				.verticalScroll(scroll)
				.windowInsetsPadding(WindowInsets.navigationBars)
				.padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 40.dp),
			verticalArrangement = Arrangement.spacedBy(18.dp),
		) {
			BandedCover(t, bands)
			Column {
				Ticking({ formatTime(position()) }) { now ->
					BasicText(
						buildAnnotatedString {
							withStyle(SpanStyle(color = C.fg)) { append(now) }
							append(" / ${formatTime(duration)}")
						},
						Modifier.background(C.lineSoft).padding(horizontal = 8.dp, vertical = 3.dp).semantics { contentDescription = "$now of ${formatTime(duration)}" },
						style = T.mono(12.sp, C.fg2),
					)
				}
				OverviewMap(peaks, skin, duration, position, a.cues, Modifier.fillMaxWidth().height(60.dp).semantics { contentDescription = "Track overview. Tap or drag to seek" }, onScrub = onScrub, onCallOff = onCallOff, onSeek = onSeek)
				Spacer(Modifier.height(4.dp))
				PhraseLane(a.phrases, skin, duration, Modifier.fillMaxWidth().height(5.dp))
			}
			Column(Modifier.padding(top = 0.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
				Controls(tr)
				tr.caption?.let { BasicText(it, Modifier.fillMaxWidth(), style = T.of(12.5.sp, color = C.fg2).copy(textAlign = TextAlign.Center)) }
			}
			if (scores.isNotEmpty()) Analysis(scores)
			Section("Tags") {
				FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
					for (tag in t.tags) TagPill(tag, height = 28.dp)
					AddTag(openActions)
				}
			}
			Column {
				val playlists = uses?.playlists?.size ?: 0
				val sets = uses?.sets?.size ?: 0
				if (playlists > 0 || sets > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(C.lineSoft))
				if (playlists > 0) UseRow(Icon.Playlists, "In", playlists, if (playlists == 1) "playlist" else "playlists") { openUses(false) }
				if (sets > 0) UseRow(Icon.Set, "Played in", sets, if (sets == 1) "set" else "sets") { openUses(true) }
				playingFrom?.let { src ->
					Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
						SourceDot(src)
						BasicText("Playing from ${sourceName(src)}", style = T.of(12.sp, color = C.fg2))
					}
				}
			}
			if (people.artists.isNotEmpty()) Section("Artists", gap = 10.dp) {
				FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
					for (artist in people.artists) Person(artist.name, people.artistPicture(artist.name), "Open artist ${artist.name}", ring = false) { openArtist(artist) }
				}
			}
			people.label?.let { label ->
				Section("Label", gap = 10.dp) { Person(label, people.labelPicture(label), "Open label $label", ring = true) { openLabel(label) } }
			}
		}
	}
}

/** The transport and what goes with it. */
internal class Transport(
	val playing: Boolean,
	/** Under the controls: why it can't play, else where it plays from. */
	val caption: String?,
	val onPlay: () -> Unit,
	val onCue: () -> Unit,
	val onJump: (Int) -> Unit,
	val onNext: (() -> Unit)?,
	val onPrevious: (() -> Unit)?,
	val onSimilar: () -> Unit,
	/** The heart: filled while the library holds the track. */
	val inLibrary: Boolean,
	/** A tap on the heart: Interested when empty, Organize when filled. */
	val onHeart: () -> Unit,
)

// ── the cover ───────────────────────────────────────────────────────────────

/**
 * The cover with its facts on it, a black band to each line (the feed
 * cards' overlays), each corner over a soft patch of the cover blurred and
 * darkened, there only to ease the read: no edge, no border, faded out from
 * its corner (opaque to 40%, gone at 100%), each sized to what it carries.
 */
@Composable
private fun BandedCover(t: Track, b: CoverBands) {
	BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(1f).clearAndSetSemantics { contentDescription = b.spoken(); role = Role.Image }) {
		val wide = maxWidth
		// Each corner group's size, read while drawing the glass.
		var tl by remember { mutableStateOf(IntSize.Zero) }
		var tr by remember { mutableStateOf(IntSize.Zero) }
		var bl by remember { mutableStateOf(IntSize.Zero) }
		var br by remember { mutableStateOf(IntSize.Zero) }
		CoverFill(t.coverUrl, t.id, Modifier.fillMaxSize())
		CoverFill(
			t.coverUrl, t.id,
			Modifier
				.fillMaxSize()
				.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
				.drawWithContent {
					drawContent()
					drawRect(Color.Black.copy(alpha = 0.22f))
					val inset = 8.dp.toPx() + 40.dp.toPx()
					glassMask(listOf(Corner(tl, 0f, 0f), Corner(tr, 1f, 0f), Corner(bl, 0f, 1f), Corner(br, 1f, 1f)), inset)
				}
				.blur(40.dp),
		)
		val pad = Modifier.padding(8.dp)
		val left = b.topLeft
		if (left.isNotEmpty()) Column(
			pad.align(Alignment.TopStart).widthIn(max = wide * 0.7f).onSizeChanged { tl = it },
			verticalArrangement = Arrangement.spacedBy(3.dp),
		) {
			b.title?.let { Band(it, T.of(15.5.sp, 600, C.fg)) }
			b.artists?.let { Band(it, T.of(13.sp, color = C.fg1)) }
			b.album?.let { Band(it, T.of(12.5.sp, color = C.fg2)) }
		}
		if (b.hasTopRight) Column(
			pad.align(Alignment.TopEnd).onSizeChanged { tr = it },
			horizontalAlignment = Alignment.End,
			verticalArrangement = Arrangement.spacedBy(3.dp),
		) {
			b.bpm?.let { Band(it, T.mono(14.sp, C.fg)) }
			b.key?.let { Box(Modifier.background(BAND).padding(horizontal = 6.dp, vertical = 4.dp)) { KeyChip(it, height = 20.dp, fontSize = 12.5f) } }
		}
		val lower = b.bottomLeft
		if (lower.isNotEmpty()) Column(
			pad.align(Alignment.BottomStart).widthIn(max = wide * 0.64f).onSizeChanged { bl = it },
			verticalArrangement = Arrangement.spacedBy(3.dp),
		) {
			b.label?.let { Band(it, T.of(13.sp, color = C.fg)) }
			b.genre?.let { Band(it, T.of(12.5.sp, color = C.fg1)) }
		}
		b.released?.let { Band(it, T.of(12.5.sp, color = C.fg1), pad.align(Alignment.BottomEnd).onSizeChanged { s -> br = s }) }
	}
}

private val BAND = Color.Black.copy(alpha = 0.78f)

@Composable
private fun Band(text: String, style: TextStyle, modifier: Modifier = Modifier) {
	BasicText(text, modifier.background(BAND).padding(horizontal = 7.dp, vertical = 3.dp), style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** A corner group's size, and which corner (0 or 1 across, 0 or 1 down). */
private class Corner(val size: IntSize, val x: Float, val y: Float)

/**
 * Keeps only the corners' patches of what is drawn: each an ellipse from its
 * corner as wide and tall as its group plus [inset] (8dp from the edge, 40dp
 * of feather), opaque to 40% of the way and gone at its edge (CSS's
 * radial-gradient(farthest-side at a corner)). A corner with nothing in it
 * has no patch.
 */
private fun DrawScope.glassMask(corners: List<Corner>, inset: Float) {
	drawIntoCanvas { canvas ->
		canvas.saveLayer(Rect(Offset.Zero, size), Paint().apply { blendMode = BlendMode.DstIn })
		for (c in corners) {
			if (c.size == IntSize.Zero) continue
			val w = c.size.width + inset
			val h = c.size.height + inset
			val at = Offset(c.x * size.width, c.y * size.height)
			// A circle of radius w, squashed to h tall about the corner: the ellipse.
			scale(1f, h / w, pivot = at) {
				drawRect(
					Brush.radialGradient(0f to Color.Black, 0.4f to Color.Black, 1f to Color.Transparent, center = at, radius = w),
					topLeft = Offset(at.x - c.x * w, at.y - c.y * w), size = Size(w, w),
				)
			}
		}
		canvas.restore()
	}
}

// ── the controls ────────────────────────────────────────────────────────────

@Composable
private fun Controls(tr: Transport) {
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
		Control(Icon.Similar, "Find similar", 48.dp, 24.dp, onClick = tr.onSimilar)
		Control(Icon.Previous, "Previous track", 52.dp, 26.dp, onClick = tr.onPrevious)
		Box(
			Modifier.size(64.dp).clip(CircleShape).background(C.fg)
				.clickable(role = Role.Button, onClickLabel = if (tr.playing) "Pause" else "Play", onClick = tr.onPlay)
				.semantics { contentDescription = if (tr.playing) "Pause" else "Play" },
			contentAlignment = Alignment.Center,
		) { IconGlyph(if (tr.playing) Icon.Pause else Icon.Play, Color.Black, 24.dp) }
		Control(Icon.Next, "Next track", 52.dp, 26.dp, onClick = tr.onNext)
		Control(
			if (tr.inLibrary) Icon.HeartFill else Icon.Heart, if (tr.inLibrary) "Organize" else "Add to Interested", 48.dp, 24.dp,
			tint = if (tr.inLibrary) C.accent else C.fg,
			onClick = tr.onHeart,
		)
	}
}

@Composable
private fun Control(icon: Icon, label: String, box: androidx.compose.ui.unit.Dp, glyph: androidx.compose.ui.unit.Dp, tint: Color = C.fg, onClick: (() -> Unit)?) {
	Box(
		Modifier.size(box)
			.clickable(enabled = onClick != null, role = Role.Button, onClickLabel = label) { onClick?.invoke() }
			.semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { IconGlyph(icon, if (onClick != null) tint else C.fg4, glyph, 1.6f) }
}

// ── below the controls ──────────────────────────────────────────────────────

@Composable
private fun Section(title: String, gap: androidx.compose.ui.unit.Dp = 8.dp, content: @Composable () -> Unit) {
	Column(verticalArrangement = Arrangement.spacedBy(gap)) {
		BasicText(title, Modifier.semantics { heading() }, style = T.of(12.sp, 500, C.fg2))
		content()
	}
}

/** Power, Brightness, Density: two to a row (the last on its own), each a meter with its name and value over the bar. */
@Composable
private fun Analysis(scores: List<Score>) {
	Section("Analysis") {
		Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
			for (pair in scores.chunked(2)) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				for (s in pair) Meter(s, Modifier.weight(1f))
				if (pair.size == 1) Spacer(Modifier.weight(1f))
			}
		}
	}
}

private val METER_FILL = Color(0xFF26262D)

@Composable
private fun Meter(s: Score, modifier: Modifier) {
	Box(
		modifier
			.height(32.dp)
			.background(C.bg2)
			.drawBehind {
				val w = size.width * s.value / 100f
				drawRect(METER_FILL, size = Size(w, size.height))
				if (w > 0f) drawRect(C.fg2, Offset(w - 2.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
			}
			.clearAndSetSemantics {
				contentDescription = s.label
				progressBarRangeInfo = ProgressBarRangeInfo(s.value.toFloat(), 0f..100f)
			}
			.padding(horizontal = 10.dp),
	) {
		Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
			BasicText(s.label, Modifier.weight(1f), style = T.of(13.sp, color = C.fg), maxLines = 1)
			BasicText(s.value.toString(), style = T.mono(13.sp, C.fg))
		}
	}
}

/** The dashed pill after the tags: where tags are picked (Actions, for now). */
@Composable
private fun AddTag(open: () -> Unit) {
	Box(
		Modifier
			.height(28.dp)
			.drawBehind {
				drawRoundRect(
					C.fg4, style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx()))),
					cornerRadius = CornerRadius(8.dp.toPx()),
				)
			}
			.clip(RoundedCornerShape(8.dp))
			.clickable(role = Role.Button, onClick = open)
			.padding(horizontal = 10.dp),
		contentAlignment = Alignment.Center,
	) { BasicText("Add tag", style = T.of(13.sp, color = C.fg2), maxLines = 1) }
}

@Composable
private fun UseRow(icon: Icon, lead: String, n: Int, noun: String, open: () -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.height(48.dp)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
			.clickable(role = Role.Button, onClick = open)
			.semantics(mergeDescendants = true) { contentDescription = "$lead $n $noun" },
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		IconGlyph(icon, C.fg2, 18.dp, 1.6f)
		BasicText(
			buildAnnotatedString {
				append("$lead ")
				withStyle(SpanStyle(fontFamily = T.mono(14.5.sp, C.fg).fontFamily)) { append(n.toString()) }
				append(" $noun")
			},
			Modifier.weight(1f), style = T.of(14.5.sp, color = C.fg),
		)
		IconGlyph(Icon.Chevron, C.fg2, 16.dp, 1.8f)
	}
}

/** An artist or the label: a round picture (initials on a tinted disc until one comes) over the name. */
@Composable
private fun Person(name: String, picture: String?, label: String, ring: Boolean, open: () -> Unit) {
	Column(
		Modifier
			.width(72.dp)
			.clickable(role = Role.Button, onClick = open)
			.clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { open(); true } },
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.spacedBy(6.dp),
	) {
		Box(Modifier.size(64.dp).clip(CircleShape).then(if (ring) Modifier.border(1.dp, C.fg4, CircleShape) else Modifier), contentAlignment = Alignment.Center) {
			if (picture != null) Cover(picture, name, 64.dp)
			else Box(
				Modifier.fillMaxSize().background(oklch(0.45f, 0.07f, (name.lowercase().hashCode() and 0x7fffffff) % 360f)),
				contentAlignment = Alignment.Center,
			) { BasicText(name.trim().take(1).uppercase(), style = T.of(18.sp, 600, C.fg)) }
		}
		BasicText(name, style = T.of(12.5.sp, color = C.fg1).copy(textAlign = TextAlign.Center), maxLines = 1, overflow = TextOverflow.Ellipsis)
	}
}

// ── closing the sheet ───────────────────────────────────────────────────────
// Both follow the finger on the screen, not in the sheet: the sheet moves
// with the finger, so a position inside it hardly changes as it is dragged.

private fun PointerEvent.screenY(): Float? = motionEvent?.rawY

/** The grip: dragged, the sheet follows and the last direction decides (model SheetDrag); tapped, it closes. */
private fun Modifier.gripDrag(sheet: SheetGestures, close: () -> Unit): Modifier = pointerInput(sheet) {
	val drag = SheetDrag(tapSlop = 6.dp.toPx(), step = 2.dp.toPx())
	awaitEachGesture {
		val down = awaitFirstDown()
		var last = currentEvent.screenY() ?: return@awaitEachGesture
		drag.start(open = true, height = sheet.height())
		var lowering = false
		var lifted = false
		try {
			while (true) {
				val ev = awaitPointerEvent()
				val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
				if (!ch.pressed) { lifted = true; break }
				val y = ev.screenY() ?: break
				drag.move(y - last)
				last = y
				if (!lowering && !drag.tap) { lowering = true; sheet.close() }
				if (lowering) { sheet.drag(drag.reveal); ch.consume() }
			}
		} finally {
			if (lowering) sheet.end(lifted && drag.release())
		}
		if (!lowering && lifted) close()
	}
}

/**
 * A pull down on the player's content while it is scrolled to the top lowers
 * the sheet with the finger; on release the last direction decides, as on
 * the grip. Only a gesture that starts at the top and goes down first: one
 * that scrolls the content, or goes sideways (Actions), is never taken.
 * Seen before the scroll does (the Initial pass), and taken from it once it
 * is a pull.
 */
private fun Modifier.pullToClose(sheet: SheetGestures, scroll: ScrollState): Modifier = pointerInput(sheet, scroll) {
	val drag = SheetDrag(tapSlop = 6.dp.toPx(), step = 2.dp.toPx())
	val slop = viewConfiguration.touchSlop
	awaitEachGesture {
		val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
		if (scroll.value > 0) return@awaitEachGesture
		var last = currentEvent.screenY() ?: return@awaitEachGesture
		var dx = 0f
		var dy = 0f
		var pulling = false
		var lifted = false
		try {
			while (true) {
				val ev = awaitPointerEvent(PointerEventPass.Initial)
				val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
				if (!ch.pressed) { lifted = true; break }
				val y = ev.screenY() ?: break
				val step = y - last
				last = y
				if (!pulling) {
					dx += ch.positionChange().x
					dy += step
					if (abs(dx) > slop && abs(dx) > abs(dy)) break
					if (dy < -slop) break
					if (dy <= slop) continue
					pulling = true
					drag.start(open = true, height = sheet.height())
					sheet.close()
					drag.move(dy)
				} else drag.move(step)
				sheet.drag(drag.reveal)
				ch.consume()
			}
		} finally {
			if (pulling) sheet.end(lifted && drag.release())
		}
	}
}
