package app.curator.mobile.ui.feed

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import app.curator.mobile.model.FeedArtist
import app.curator.mobile.model.FeedItem
import app.curator.mobile.model.Heart
import app.curator.mobile.model.Slide
import app.curator.mobile.model.credits
import app.curator.mobile.model.dotWindow
import app.curator.mobile.model.feedArtists
import app.curator.mobile.model.feedDate
import app.curator.mobile.model.feedDateSpoken
import app.curator.mobile.model.feedLink
import app.curator.mobile.model.feedSubtitle
import app.curator.mobile.ui.common.ContextMenu
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.MenuItem
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.oklch
import kotlinx.coroutines.launch

private val BAND = Color(0xC7000000)
private const val DIMMED = 0.38f

/** One card: who and why, the cover (a release's pages through its tracks), the date and the actions. */
@Composable
fun FeedCard(feed: FeedModel, item: FeedItem, width: Dp, playingId: String?) {
	val slides = feed.slides(item)
	val pager = rememberPagerState(initialPage = (feed.slideAt[item.id] ?: 0).coerceIn(0, slides.lastIndex)) { slides.size }
	LaunchedEffect(pager.currentPage) { if (slides.size > 1) feed.slideAt[item.id] = pager.currentPage }
	val slide = slides[pager.currentPage.coerceIn(0, slides.lastIndex)]
	Column(
		Modifier
			.fillMaxWidth()
			.drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
			.padding(bottom = 4.dp),
	) {
		Header(feed, item)
		Gallery(item, slides, pager, width)
		Footer(feed, item, slides.size, slide, pager.currentPage, playingId)
	}
}

// ── header ──────────────────────────────────────────────────────────────────

@Composable
private fun Header(feed: FeedModel, item: FeedItem) {
	val artists = feedArtists(item)
	val sub = feedSubtitle(item, feed.owner(item))
	val kind = if (item.isRelease) "Release" else "Track"
	Row(
		Modifier.fillMaxWidth().padding(start = 16.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(10.dp),
	) {
		Avatars(feed, item.payload.credits.take(FeedModel.AVATARS))
		Column(
			Modifier.weight(1f).clearAndSetSemantics {
				contentDescription = "$kind ${item.payload.title} by $artists. ${if (item.isRelease) "" else sub}"
				heading()
			},
			verticalArrangement = Arrangement.spacedBy(2.dp),
		) {
			Line(artists, T.of(14.sp, 600, C.fg))
			if (sub.isNotEmpty()) Line(sub, T.of(12.5.sp, color = C.fg2))
		}
		Menu(feed, item, Modifier.align(Alignment.Top).offset(y = (-4).dp))
	}
}

// Overlapping by 12dp, the first on top: the ring, a gap, the picture.
@Composable
private fun Avatars(feed: FeedModel, artists: List<FeedArtist>) {
	if (artists.isEmpty()) return
	Box(Modifier.width(34.dp + 22.dp * (artists.size - 1)).height(34.dp).clearAndSetSemantics { }) {
		artists.forEachIndexed { i, a ->
			Box(
				Modifier
					.offset(x = 22.dp * i)
					.zIndex((artists.size - i).toFloat())
					.size(34.dp)
					.clip(CircleShape)
					.background(C.bg)
					.border(2.dp, C.accent, CircleShape)
					.padding(4.dp)
					.clip(CircleShape),
			) {
				Initials(a.name)
				feed.picture(a)?.let { Cover(it, a.name, 26.dp) }
			}
		}
	}
}

@Composable
private fun Initials(name: String) {
	val hue = (name.hashCode() and 0x7fffffff) % 360f
	Box(Modifier.fillMaxSize().background(oklch(0.55f, 0.08f, hue)), contentAlignment = Alignment.Center) {
		val letters = name.split(' ').filter { it.isNotEmpty() }.take(2).joinToString("") { it.first().uppercase() }
		BasicText(letters, style = T.of(9.sp, 600, Color.White), maxLines = 1)
	}
}

@Composable
private fun Menu(feed: FeedModel, item: FeedItem, modifier: Modifier) {
	var open by remember { mutableStateOf(false) }
	val context = LocalContext.current
	val below = with(LocalDensity.current) { 44.dp.roundToPx() }
	Box(modifier) {
		IconButton(Icon.Menu, "Actions for ${item.payload.title}", tint = C.fg) { open = true }
		if (open) ContextMenu(
			item.payload.title,
			buildList {
				add(MenuItem("Dismiss from feed") { feed.dismiss(item) })
				feedLink(item)?.let { (url, store) ->
					add(MenuItem("Open in $store") {
						runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }.onFailure { feed.notice = "Nothing on this phone opens that link" }
					})
				}
				for (a in item.payload.credits.take(FeedModel.AVATARS)) if (a.key != null) add(MenuItem("Hide ${a.name}") { feed.hide(item, a) })
			},
			below,
			alignment = Alignment.TopEnd,
		) { open = false }
	}
}

// ── the image ───────────────────────────────────────────────────────────────

@Composable
private fun Gallery(item: FeedItem, slides: List<Slide>, pager: PagerState, width: Dp) {
	if (slides.size == 1) {
		Box(Modifier.size(width).semantics(mergeDescendants = true) { }) { SlideImage(item, slides[0], width) }
		return
	}
	val scope = rememberCoroutineScope()
	fun go(by: Int): Boolean {
		val to = pager.currentPage + by
		if (to !in slides.indices) return false
		scope.launch { pager.animateScrollToPage(to) }
		return true
	}
	HorizontalPager(
		pager,
		Modifier
			.size(width)
			// The design's tap zones: the left and right third, clear of the corners' bands.
			.pointerInput(item.id, slides.size) {
				detectTapGestures { at ->
					if (at.y < 64.dp.toPx() || at.y > 264.dp.toPx()) return@detectTapGestures
					if (at.x < size.width / 3f) go(-1) else if (at.x > size.width * 2 / 3f) go(1)
				}
			}
			.semantics {
				stateDescription = "Item ${pager.currentPage + 1} of ${slides.size}"
				customActions = listOf(
					CustomAccessibilityAction("Next track") { go(1) },
					CustomAccessibilityAction("Previous track") { go(-1) },
				)
			},
		key = { slides.getOrNull(it)?.track?.sourceTrackId?.let { id -> "$it:$id" } ?: "$it" },
	) { page -> slides.getOrNull(page)?.let { s -> Box(Modifier.size(width).semantics(mergeDescendants = true) { }) { SlideImage(item, s, width) } } }
}

@Composable
private fun BoxScope.SlideImage(item: FeedItem, s: Slide, width: Dp) {
	Box(Modifier.matchParentSize().clipToBounds()) {
		Cover(item.payload.coverUrl, item.id, width)
		Bands(Alignment.TopStart, 280.dp) {
			s.topLeft.getOrNull(0)?.let { Band(it, T.of(13.5.sp, 500, C.fg)) }
			s.topLeft.getOrNull(1)?.let { Band(it, T.of(12.sp)) }
		}
		s.topRight?.let { Bands(Alignment.TopEnd, 200.dp) { Band(it, T.mono(12.sp, C.fg)) } }
		Bands(Alignment.BottomStart, 250.dp) {
			s.bottomLeft.getOrNull(0)?.let { Band(it, T.of(13.sp, color = C.fg)) }
			s.bottomLeft.getOrNull(1)?.let { Band(it, T.of(12.sp)) }
		}
		Bands(Alignment.BottomEnd, 130.dp) {
			s.bottomRight?.let { Band(it, T.of(13.sp, color = C.fg)) }
			s.duration?.let { Band(it, T.mono(12.5.sp)) }
			s.bpm?.let { Band(it, T.mono(13.sp, C.fg), spoken = "$it BPM") }
			s.key?.let { Box(Modifier.background(BAND).padding(horizontal = 6.dp, vertical = 4.dp)) { KeyChip(it, height = 16.dp, fontSize = 11.5f) } }
		}
		if (s.ribbon) Ribbon()
	}
}

@Composable
private fun BoxScope.Bands(corner: Alignment, maxWidth: Dp, content: @Composable () -> Unit) {
	val end = corner == Alignment.TopEnd || corner == Alignment.BottomEnd
	Column(
		Modifier.align(corner).padding(8.dp).widthIn(max = maxWidth),
		verticalArrangement = Arrangement.spacedBy(4.dp),
		horizontalAlignment = if (end) Alignment.End else Alignment.Start,
	) { content() }
}

@Composable
private fun Band(text: String, style: TextStyle, spoken: String? = null) {
	Line(text, style, Modifier.background(BAND).padding(horizontal = 8.dp, vertical = 4.dp).then(if (spoken == null) Modifier else Modifier.semantics { contentDescription = spoken }))
}

@Composable
private fun BoxScope.Ribbon() {
	Box(
		Modifier.align(Alignment.TopEnd).offset(x = 34.dp, y = 22.dp).size(width = 140.dp, height = 24.dp).rotate(45f).shadow(4.dp).background(C.buy),
		contentAlignment = Alignment.Center,
	) { BasicText("In Library", style = T.of(12.sp, 600, Color.Black), maxLines = 1) }
}

// ── footer ──────────────────────────────────────────────────────────────────

@Composable
private fun Footer(feed: FeedModel, item: FeedItem, count: Int, slide: Slide, at: Int, playingId: String?) {
	val context = LocalContext.current
	Row(Modifier.fillMaxWidth().height(44.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
		val spoken = feedDateSpoken(item)
		Line(feedDate(item.date), T.of(12.5.sp, color = C.fg2), Modifier.width(132.dp).padding(start = 12.dp).semantics { contentDescription = spoken })
		Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { if (count > 1) Dots(at, count) }
		Row(Modifier.width(132.dp), horizontalArrangement = Arrangement.End) {
			val track = slide.track
			if (track != null && slide.heart != Heart.NONE) HeartButton(
				slide.heart, track.title,
				why = if (slide.held?.deleted == true) FeedModel.DELETED else FeedModel.NOT_ON_SPOTIFY,
				onWhy = { feed.notice = it },
			) { organize -> feed.heart(item, track, slide.held, on = organize || slide.heart != Heart.ON, organize = organize) }
			val link = feedLink(item)
			DimmableButton(Icon.Share, "Share ${item.payload.title}", why = "No page to share for this yet".takeIf { link == null }, onWhy = { feed.notice = it }) {
				val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link!!.first)
				context.startActivity(Intent.createChooser(send, null))
			}
			val plays = slide.plays
			val playing = plays != null && playingId != null && feed.playerId(plays) == playingId
			DimmableButton(
				if (playing) Icon.Pause else Icon.Play,
				(if (playing) "Pause " else "Play ") + (track?.title ?: item.payload.title),
				why = FeedModel.NOT_ON_SPOTIFY.takeIf { plays == null }, onWhy = { feed.notice = it },
			) { feed.play(item, plays!!) }
		}
	}
}

@Composable
private fun Dots(at: Int, count: Int) {
	Row(Modifier.clearAndSetSemantics { contentDescription = "Item ${at + 1} of $count" }, horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
		val window = dotWindow(at, count)
		for (i in window) {
			// A gallery longer than the dots goes on past the edge: its last dot is small.
			val more = (i == window.first && i > 0) || (i == window.last && i < count - 1)
			Box(Modifier.size(6.dp), contentAlignment = Alignment.Center) {
				Box(Modifier.size(if (more && i != at) 4.dp else 6.dp).clip(CircleShape).background(if (i == at) C.accent else C.fg3))
			}
		}
	}
}

/** Interested: a tap toggles it; a long press marks the track and organises it. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HeartButton(state: Heart, title: String, why: String, onWhy: (String) -> Unit, onPress: (organize: Boolean) -> Unit) {
	val haptics = LocalHapticFeedback.current
	val dimmed = state == Heart.DIMMED
	Box(
		Modifier
			.size(44.dp)
			.combinedClickable(
				role = Role.Button,
				onLongClickLabel = if (dimmed) null else "Interested and organize",
				onLongClick = if (dimmed) null else ({ haptics.performHapticFeedback(HapticFeedbackType.LongPress); onPress(true) }),
			) { if (dimmed) onWhy(why) else onPress(false) }
			.semantics {
				contentDescription = "Interested in $title"
				if (dimmed) { stateDescription = why; disabled() } else toggleableState = if (state == Heart.ON) ToggleableState.On else ToggleableState.Off
			}
			.alpha(if (dimmed) DIMMED else 1f),
		contentAlignment = Alignment.Center,
	) {
		if (state == Heart.ON) IconGlyph(Icon.HeartFill, C.accent)
		IconGlyph(Icon.Heart, if (state == Heart.ON) C.accent else C.fg, strokeWidth = 1.6f)
	}
}

/** An icon button; with a [why] it is dimmed, and a tap says it. */
@Composable
private fun DimmableButton(icon: Icon, label: String, why: String?, onWhy: (String) -> Unit, onClick: () -> Unit) {
	IconButton(
		icon, label, tint = C.fg,
		modifier = if (why == null) Modifier else Modifier.alpha(DIMMED).semantics { stateDescription = why; disabled() },
	) { if (why == null) onClick() else onWhy(why) }
}
