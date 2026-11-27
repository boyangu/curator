package app.curator.mobile.ui.entity

import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.model.EntityHeader
import app.curator.mobile.model.EntityRef
import app.curator.mobile.model.EntityWorld
import app.curator.mobile.model.Scope
import app.curator.mobile.model.Sticky
import app.curator.mobile.model.releasesLine
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Covers
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.oklch
import java.util.UUID

/*
 * An artist's or a label's page (canvas: Basic views → "Artist and label",
 * Entity.dc.html): the hero with its bands and the scope switch, the
 * attributes, the status lines, then Releases / Tracks. One list scrolls
 * under a fixed top bar; the hero's bands fade and the name docks in the bar
 * as it goes (model Sticky), driven by the scroll alone.
 */

internal val HERO = 330.dp
internal val BAND = Color.Black.copy(alpha = 0.78f)
/** The Follow fill and the switch's knob: a darker cyan white text reads on. */
internal val FOLLOWING = oklch(0.48f, 0.11f, 210f)
private val FOLLOW = Color(0xFF3A3A42)
private val GLASS = Color.Black.copy(alpha = 0.55f)

@Composable
fun EntityScreen(model: AppModel, ref: EntityRef, bottom: @Composable () -> Unit, back: () -> Unit, push: (Screen) -> Unit) {
	// This entry's page, kept by the app while the entry may come back (back returns to it as it was).
	val key = rememberSaveable { UUID.randomUUID().toString() }
	val page = remember(key) { model.entityPage(key, ref) }
	LaunchedEffect(page) { page.start() }
	val header = page.header ?: EntityHeader(ref = ref, world = EntityWorld(available = false, reason = if (page.failed) "" else "pending"))

	val list = rememberLazyListState()
	val density = LocalDensity.current
	// How far the page has scrolled, in dp; the hero is its first item, and past it the bar is docked for good.
	val y = remember(list) {
		derivedStateOf { if (list.firstVisibleItemIndex > 0) Float.MAX_VALUE else with(density) { list.firstVisibleItemScrollOffset.toDp().value } }
	}
	LaunchedEffect(page.listReset) {
		// A scope change starts the list at its top, the header left where it was.
		if (page.listReset > 0 && list.firstVisibleItemIndex > LIST_TOP) list.scrollToItem(LIST_TOP)
	}

	Box(Modifier.fillMaxSize().background(C.bg)) {
		Column(Modifier.fillMaxSize()) {
			Box(Modifier.weight(1f).fillMaxWidth()) {
				EntityList(model, page, header, list, y, push)
				TopBar(header.ref.name, y, back) { page.sheet = EntitySheet.Menu }
			}
			bottom()
		}
		EntitySheets(page, header, push)
	}
	BackHandler(enabled = page.sheet != null) { page.sheet = null }
}

/** The list's own top (the Releases / Tracks switch), below the hero, the attributes and the status lines. */
internal const val LIST_TOP = 3

// ── the top bar ─────────────────────────────────────────────────────────────

@Composable
private fun TopBar(name: String, y: State<Float>, back: () -> Unit, menu: () -> Unit) {
	val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
	val docked by remember(y) { derivedStateOf { Sticky.docked(y.value) } }
	Row(
		Modifier
			.fillMaxWidth()
			.drawBehind {
				val a = Sticky.barAlpha(y.value)
				if (a > 0f) {
					drawRect(C.bg.copy(alpha = a))
					drawLine(C.lineSoft.copy(alpha = a), Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx())
				}
			}
			.padding(start = 12.dp, end = 12.dp, top = top + 8.dp, bottom = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(10.dp),
	) {
		GlassButton(Icon.Back, "Back", back)
		Box(Modifier.weight(1f).height(40.dp), contentAlignment = Alignment.CenterStart) {
			// On at once when docked: no slide, no fade.
			if (docked) BasicText(name, Modifier.semantics { heading() }, style = T.of(17.sp, 600, C.fg), maxLines = 1, overflow = TextOverflow.Ellipsis)
		}
		GlassButton(Icon.Menu, "Open in a streaming service or store", menu)
	}
}

/** Back and the menu: 40dp dark-glass discs, over the hero or the docked bar alike. */
@Composable
private fun GlassButton(icon: Icon, label: String, onClick: () -> Unit) {
	Box(
		Modifier
			.size(40.dp)
			.clip(CircleShape)
			.background(GLASS)
			.clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
			.semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { IconGlyph(icon, C.fg, 20.dp, 1.9f) }
}

// ── the hero ────────────────────────────────────────────────────────────────

@Composable
internal fun Hero(page: EntityPageModel, h: EntityHeader, y: State<Float>) {
	val ref = h.ref
	Box(Modifier.fillMaxWidth().height(HERO)) {
		HeroImage(h.imageUrl, ref)
		// Name, Reach, the releases line, Follow, and the scope switch: 8dp in, fading as the page scrolls.
		Row(
			Modifier
				.align(Alignment.BottomStart)
				.fillMaxWidth()
				.padding(8.dp)
				.graphicsLayer { alpha = Sticky.heroAlpha(y.value) },
			verticalAlignment = Alignment.Top,
		) {
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
				Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
					NameBand(ref.name, Modifier.weight(1f, fill = false)) { page.sheet = EntitySheet.About }
					h.reach?.let { r ->
						val score = "%.1f".format(r.score)
						Box(
							Modifier
								.fillMaxHeight()
								.background(BAND)
								.clickable(role = Role.Button, onClickLabel = "Show breakdown") { page.sheet = EntitySheet.Reach }
								.semantics { contentDescription = "Reach $score" }
								.padding(horizontal = 8.dp),
							contentAlignment = Alignment.Center,
						) { BasicText(score, style = T.mono(17.sp, C.fg, 500)) }
					}
				}
				Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
					val count = if (page.scope == Scope.OWNED) page.owned?.let { page.ownedReleases.size } else h.world.releaseCount
					releasesLine(page.scope, count)?.let {
						BasicText(it, Modifier.background(BAND).padding(horizontal = 8.dp, vertical = 3.dp), style = T.of(13.sp, color = C.fg1).copy(lineHeight = 17.sp), maxLines = 1)
					}
					h.follow?.let { f -> FollowButton(f.following, page::toggleFollow) }
				}
			}
			Spacer(Modifier.width(8.dp))
			ScopeSwitch(page.scope, page::toggleScope)
		}
	}
}

@Composable
private fun NameBand(name: String, modifier: Modifier, onClick: () -> Unit) {
	BasicText(
		buildAnnotatedString {
			append(name)
			withStyle(SpanStyle(fontSize = 13.sp, color = C.accent)) { append("  ✦") }
		},
		modifier
			.background(BAND)
			.clickable(role = Role.Button, onClickLabel = "Show what the assistant found", onClick = onClick)
			.semantics { contentDescription = "About $name: researched info" }
			.padding(horizontal = 8.dp, vertical = 3.dp),
		style = T.of(26.sp, 600, C.fg).copy(lineHeight = 30.sp),
		maxLines = 1, overflow = TextOverflow.Ellipsis,
	)
}

/** As tall as the releases band beside it: no border, white on its fill. */
@Composable
private fun FollowButton(following: Boolean, onToggle: () -> Unit) {
	Box(
		Modifier
			.fillMaxHeight()
			.background(if (following) FOLLOWING else FOLLOW)
			.toggleable(value = following, role = Role.Button, onValueChange = { onToggle() })
			.semantics { contentDescription = "Follow"; stateDescription = if (following) "Following" else "Not following" }
			.padding(horizontal = 10.dp, vertical = 3.dp),
		contentAlignment = Alignment.Center,
	) { BasicText(if (following) "Following" else "Follow", style = T.of(13.sp, 500, Color.White).copy(lineHeight = 17.sp)) }
}

/**
 * The picture filling the hero, or for want of one a label's big initial on
 * bg-2 or an artist's initial disc; under the bands' corner a soft patch of
 * it blurred and darkened (the player's cover glass), feathered from the
 * corner out.
 */
@Composable
private fun HeroImage(url: String?, ref: EntityRef) {
	val context = LocalContext.current
	BoxWithConstraints(Modifier.fillMaxSize()) {
		val px = with(LocalDensity.current) { maxWidth.roundToPx() }
		val image by produceState<ImageBitmap?>(null, url, px) { value = url?.let { Covers.load(context, it, px) } }
		val initial = ref.name.trim().take(1).uppercase()
		val hue = (ref.name.lowercase().hashCode() and 0x7fffffff) % 360f
		val shot = image
		if (shot != null) {
			Image(shot, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
			Image(
				shot, contentDescription = null, contentScale = ContentScale.Crop,
				modifier = Modifier
					.fillMaxSize()
					.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
					.drawWithContent {
						drawContent()
						drawRect(Color.Black.copy(alpha = 0.22f))
						cornerPatch(340.dp.toPx(), 150.dp.toPx())
					}
					.blur(40.dp),
			)
		} else {
			if (ref.isLabel) Box(Modifier.fillMaxSize().background(C.bg2), contentAlignment = Alignment.Center) {
				BasicText(initial, style = T.of(140.sp, 600, C.fg4))
			} else Box(Modifier.fillMaxSize().background(oklch(0.30f, 0.04f, hue)), contentAlignment = Alignment.Center) {
				Box(Modifier.offset(y = (-24).dp).size(168.dp).clip(CircleShape).background(oklch(0.45f, 0.07f, hue)), contentAlignment = Alignment.Center) {
					BasicText(initial, style = T.of(72.sp, 600, C.fg))
				}
			}
			Box(
				Modifier
					.fillMaxSize()
					.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
					.drawWithContent { drawRect(Color.Black.copy(alpha = 0.22f)); cornerPatch(340.dp.toPx(), 150.dp.toPx()) },
			)
		}
	}
}

/** Keeps only an ellipse from the bottom-left corner, [w] by [h], opaque to 40% of the way and gone at its edge. */
private fun DrawScope.cornerPatch(w: Float, h: Float) {
	drawIntoCanvas { canvas ->
		canvas.saveLayer(Rect(Offset.Zero, size), Paint().apply { blendMode = BlendMode.DstIn })
		val at = Offset(0f, size.height)
		scale(1f, h / w, pivot = at) {
			drawRect(Brush.radialGradient(0f to Color.Black, 0.4f to Color.Black, 1f to Color.Transparent, center = at, radius = w), topLeft = Offset(0f, at.y - w), size = Size(w, w))
		}
		canvas.restore()
	}
}

// ── the scope switch: My Library (left) / World Library (right) ─────────────

private val KNOB_EASE = CubicBezierEasing(.3f, 1.4f, .5f, 1f)
private val GLOBE_EASE = CubicBezierEasing(.3f, 1.2f, .5f, 1f)
private const val SHELF = "M3 3v12M7 3v12M10.5 4.2l3.6 10.6M1.5 16h15"
private const val GLOBE = "M9 2a7 7 0 1 0 0 14a7 7 0 1 0 0-14M2 9h14M9 2c2.2 2 2.8 4.4 2.8 7s-.6 5-2.8 7c-2.2-2-2.8-4.4-2.8-7S6.8 4 9 2z"

/** Whether the system asks for less motion (animations off in Developer or Accessibility settings). */
@Composable
internal fun reduceMotion(): Boolean {
	val resolver = LocalContext.current.contentResolver
	return remember(resolver) { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

@Composable
private fun ScopeSwitch(scope: Scope, onToggle: () -> Unit) {
	val world = scope == Scope.WORLD
	val calm = reduceMotion()
	val knob by animateDpAsState(if (world) 34.dp else 0.dp, if (calm) tween(150) else tween(260, easing = KNOB_EASE), label = "knob")
	val libFg by animateColorAsState(if (world) C.fg3 else Color.White, tween(if (calm) 150 else 200), label = "libFg")
	val worldFg by animateColorAsState(if (world) Color.White else C.fg3, tween(if (calm) 150 else 200), label = "worldFg")
	// Reduce Motion: the colours alone change, no scale, no turn.
	val libScale by animateFloatAsState(if (!calm && world) 0.82f else 1f, tween(260), label = "libScale")
	val worldScale by animateFloatAsState(if (!calm && !world) 0.82f else 1f, tween(260), label = "worldScale")
	val turn by animateFloatAsState(if (world || calm) 0f else -90f, tween(420, easing = GLOBE_EASE), label = "globe")
	val label = if (world) "Showing world library. Switch to my library" else "Showing my library. Switch to world library"
	Box(
		Modifier
			.width(70.dp)
			.height(36.dp)
			.background(BAND)
			// A 36dp-tall switch still answers a 48dp touch: Compose widens small targets on its own.
			.toggleable(value = world, role = Role.Switch, onValueChange = { onToggle() })
			.clearAndSetSemantics { contentDescription = label; role = Role.Switch; stateDescription = if (world) "World library" else "My library" },
	) {
		Box(Modifier.padding(4.dp).offset(x = knob).size(28.dp).background(FOLLOWING))
		Box(Modifier.padding(4.dp).size(28.dp).graphicsLayer { scaleX = libScale; scaleY = libScale }, contentAlignment = Alignment.Center) {
			Glyph(SHELF, 18f, libFg, 18.dp, 2f)
		}
		Box(
			Modifier.align(Alignment.TopEnd).padding(4.dp).size(28.dp).graphicsLayer { scaleX = worldScale; scaleY = worldScale; rotationZ = turn },
			contentAlignment = Alignment.Center,
		) { Glyph(GLOBE, 18f, worldFg, 18.dp, 2f) }
	}
}

/** A stroked path on its own [box]-unit grid (the canvas's 18- and 16-unit icons). */
@Composable
internal fun Glyph(d: String, box: Float, tint: Color, size: Dp, stroke: Float) {
	val path = remember(d) { PathParser().parsePathString(d).toPath() }
	Canvas(Modifier.size(size)) {
		val s = this.size.minDimension / box
		scale(s, s, pivot = Offset.Zero) { drawPath(path, tint, style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
	}
}
