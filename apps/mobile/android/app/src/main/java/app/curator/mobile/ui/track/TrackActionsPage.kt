package app.curator.mobile.ui.track

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Track
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.list.topLine
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * One action of the Track actions page. The list is a draft (Guy has track
 * actions as TBD), so it is data: groups of these, easy to change.
 */
private class Action(
	val glyph: String,
	val label: String,
	val detail: String = "",
	val on: Boolean = false,
	val tone: Color = C.fg,
	val glyphTone: Color = C.fg2,
	val badge: String? = null,
	val enabled: Boolean = true,
	val run: () -> Unit = {},
)

private class Group(val name: String, val actions: List<Action>)

private data class Facts(val track: Track, val interested: Boolean, val basket: Boolean, val playlists: Int)

@Composable
fun TrackActionsPage(model: AppModel, trackId: String, back: () -> Unit) {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val facts by produceState<Facts?>(null, lib, version, trackId) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) {
			l.track(trackId)?.let { Facts(it, l.hasTag(trackId, "interested"), l.hasTag(trackId, "basket"), l.playlistsHolding(trackId)) }
		}
	}
	val f = facts ?: return
	val t = f.track
	val compact = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

	// Each toggle is one op, written by the desktop's own writers in the core.
	val groups = listOf(
		Group("Curate", listOf(
			Action("⌖", "Interested", if (f.interested) "on" else "", on = f.interested, glyphTone = C.accent, run = { model.setTag(t.id, "interested", !f.interested) }),
			Action("+", if (f.basket) "In basket" else "Add to basket", on = f.basket, glyphTone = if (f.basket) C.buy else C.fg2, run = { model.setTag(t.id, "basket", !f.basket) }),
			// Untags Interested; deletes nothing (decided 2026-11-23).
			Action("×", "Not interested", tone = C.hot, glyphTone = C.hot, enabled = f.interested, run = { model.notInterested(t.id) }),
		)),
		Group("Organize", listOf(
			Action("#", "Tag…", t.tags.joinToString(" · ")),
			Action("≡", "Add to playlist…", if (f.playlists > 0) f.playlists.toString() else ""),
			Action("✎", "Edit details"),
		)),
		Group("Explore", listOf(
			Action("≈", "Similar in library"),
			Action("≈", "Similar in world"),
			Action("→", if (t.artist.isNotEmpty()) "Session from ${t.artist.substringBefore(",")}" else "Start session"),
			Action("→", "Go to label", if (compact) "" else t.label ?: ""),
		)),
		Group("Prepare", listOf(
			Action("◆", "Cues and loops", badge = "P1", enabled = false),
			Action("$", "Buy as FLAC", badge = "P1", tone = C.buy, glyphTone = C.buy, enabled = false),
		)),
	)

	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState())) {
		Row(
			Modifier.fillMaxWidth().height(if (compact) 50.dp else 60.dp).padding(start = 4.dp, end = if (compact) 8.dp else 16.dp),
			verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			IconButton(Icon.Back, "Back to track", onClick = back)
			Cover(t.coverUrl, t.id, 36.dp)
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
				Line(t.title, T.of(15.sp, 500, C.fg))
				Line("${t.artist} · actions", T.of(12.5.sp, color = C.fg2))
			}
			Rating(t.rating, if (compact) 30 else 28) { n -> model.setRating(t.id, if (n == t.rating) null else n) }
		}
		if (compact) {
			Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
				for (g in groups) GroupColumn(g, rowHeight = 40, fontSize = 13.5f, Modifier.weight(1f))
			}
		} else {
			Column(Modifier.padding(horizontal = 16.dp)) { for (g in groups) GroupColumn(g, rowHeight = 48, fontSize = 15f, Modifier.fillMaxWidth()) }
		}
	}
}

@Composable
private fun Rating(value: Int?, width: Int, onPick: (Int) -> Unit) {
	Row(Modifier.semantics { contentDescription = "Rating ${value ?: 0} of 5" }, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
		for (n in 1..5) {
			val on = value != null && n <= value
			Box(
				Modifier
					.width(width.dp).height(32.dp)
					.background(if (on) C.accentDim else Color.Transparent)
					.border(1.dp, C.line)
					.clickable(role = Role.RadioButton, onClickLabel = if (n == value) "Clear rating" else "Rate $n") { onPick(n) }
					.semantics { contentDescription = "Rate $n"; selected = n == value },
				contentAlignment = Alignment.Center,
			) { BasicText(n.toString(), style = T.mono(12.5.sp, if (on) C.fg else C.fg2)) }
		}
	}
}

@Composable
private fun GroupColumn(g: Group, rowHeight: Int, fontSize: Float, modifier: Modifier) {
	Column(modifier.topLine().padding(top = 6.dp, bottom = 8.dp)) {
		BasicText(g.name, Modifier.padding(vertical = 4.dp).semantics { heading() }, style = T.label)
		for (a in g.actions) {
			Row(
				Modifier
					.fillMaxWidth()
					.height(rowHeight.dp)
					.background(if (a.on) C.accentDim else Color.Transparent)
					.drawBehind { if (a.on) drawRect(C.accent, Offset.Zero, androidx.compose.ui.geometry.Size(2.dp.toPx(), size.height)) }
					.clickable(enabled = a.enabled, role = Role.Button, onClick = a.run)
					.semantics(mergeDescendants = true) {
						if (a.on) stateDescription = "On"
						if (!a.enabled) disabled()
						role = Role.Button
					}
					.padding(horizontal = 8.dp),
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(12.dp),
			) {
				BasicText(a.glyph, Modifier.width(20.dp), style = T.of(fontSize.sp, color = if (a.enabled) a.glyphTone else C.fg4).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center))
				Line(a.label, T.of(fontSize.sp, color = if (a.enabled) a.tone else C.fg3), Modifier.weight(1f))
				when {
					a.badge != null -> Box(Modifier.border(1.dp, C.line).padding(horizontal = 5.dp, vertical = 1.dp)) { BasicText(a.badge, style = T.mono(11.sp, C.fg2)) }
					a.detail.isNotEmpty() -> BasicText(a.detail, style = T.of(12.5.sp, color = C.fg2), maxLines = 1)
				}
			}
		}
	}
}
