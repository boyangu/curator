package app.curator.mobile.ui.track

import android.content.res.Configuration
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.ArtistRef
import app.curator.mobile.data.ListQuery
import app.curator.mobile.data.Track
import app.curator.mobile.data.TrackAnalysis
import app.curator.mobile.model.GridShow
import app.curator.mobile.model.Peaks
import app.curator.mobile.model.WaveSkin
import app.curator.mobile.model.analysisScores
import app.curator.mobile.model.coverBands
import app.curator.mobile.player.Player
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.PopupMenuAnchor
import app.curator.mobile.ui.common.formatBpm
import app.curator.mobile.ui.common.formatTime
import app.curator.mobile.ui.list.playFrom
import app.curator.mobile.ui.list.rememberListInfo
import app.curator.mobile.ui.list.rememberPager
import app.curator.mobile.ui.list.rememberView
import app.curator.mobile.ui.list.scope
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.nav.LocalPageGestures
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.nav.swipeToOpen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val ZOOMS = listOf(4f, 8f, 16f, 32f)

@Composable
fun TrackScreen(model: AppModel, screen: Screen.Track, back: () -> Unit, push: (Screen) -> Unit, replace: (Screen) -> Unit) {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val metrics by model.metrics.collectAsState()
	val player by model.player.state.collectAsState()
	val scope = rememberCoroutineScope()
	val loaded by produceState<Pair<Track, TrackAnalysis>?>(null, lib, version, screen.trackId) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { l.track(screen.trackId)?.let { it to l.analysis(it.id) } }
	}
	val artists by produceState(emptyList<ArtistRef>(), lib, version, screen.trackId) {
		value = lib?.let { l -> withContext(Dispatchers.IO) { l.trackArtists(screen.trackId) } } ?: emptyList()
	}
	val uses by produceState<Uses?>(null, lib, version, screen.trackId) {
		value = lib?.let { l -> withContext(Dispatchers.IO) { Uses(l.playlistsOf(screen.trackId), l.setsOf(screen.trackId)) } }
	}
	val peaks = rememberPeaks(model, screen.trackId)
	val from = screen.from
	val listName = from?.let { rememberListInfo(model, it) }
	// The list it was opened from, as shown there (view and search): the same pager, so Next is the row below.
	val view = from?.let { rememberView(model, it) }
	val pager = rememberPager(model, if (from == null || view == null) null else ListQuery(from.scope(), view, screen.search))
	val skin by model.skin.collectAsState()
	val grid by model.grid.collectAsState()

	// The player follows the open track (rotating keeps it: same screen, same state),
	// and the mini bar raises this view of it again, list and row included.
	LaunchedEffect(screen.trackId, loaded) { loaded?.first?.let { playFrom(model, it) } }
	LaunchedEffect(screen) { model.playerScreen = screen }

	var scrub by remember { mutableStateOf<Double?>(null) }
	var zoom by rememberSaveable { mutableFloatStateOf(16f) }
	val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

	val (track, analysis) = loaded ?: run {
		Box(Modifier.fillMaxSize().background(C.bg)) { IconButton(Icon.Back, "Back", modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars), onClick = back) }
		return
	}
	val ours = player.track?.trackId == track.id
	// Read as late as possible (while drawing, or by a small text), so playback recomposes nothing here.
	val playhead = rememberPlayhead(model.player, track.id, everyFrame = landscape)
	val position = remember(playhead) { { scrub ?: playhead.value } }
	val duration = (track.durationSec ?: 0).toDouble().takeIf { it > 0 } ?: peaks?.seconds ?: 0.0
	val seek: (Double) -> Unit = { s -> scrub = null; model.player.seek(s.coerceIn(0.0, duration)) }
	val jump: (Int) -> Unit = { n -> seek(jumpBeats(analysis.beats, track.bpm, position(), n)) }
	val cuePoint = analysis.cues.firstOrNull()?.positionSec ?: 0.0
	val playPause = { if (player.playing && ours) model.player.pause() else model.player.play() }
	// The row it was opened from (a track twice in a playlist is two rows), else where it is now.
	val at = pager?.let { p -> remember(p.ids, track.id) { if (p.ids.getOrNull(screen.index) == track.id) screen.index else p.ids.indexOf(track.id) } } ?: -1
	// The row beside it in the list ([by] +1: the next); it keeps playing when this one was.
	fun step(by: Int): (() -> Unit)? = pager?.ids?.getOrNull(at + by)?.takeIf { at >= 0 }?.let { id ->
		{
			val keepPlaying = player.playing && ours
			scope.launch {
				val n = withContext(Dispatchers.IO) { lib?.track(id) } ?: return@launch
				model.open(n, start = keepPlaying)
				replace(Screen.Track(n.id, from, at + by, pager.size, screen.search))
			}
		}
	}
	val transport = Transport(
		playing = player.playing && ours, caption = (player.unavailable ?: player.note).takeIf { ours },
		onPlay = playPause, onCue = { seek(cuePoint) }, onJump = jump, onNext = step(1), onPrevious = step(-1),
		onSimilar = { push(Screen.TrackList(ListSource.Similar(track.id, track.title, track.key))) },
		inLibrary = true, onHeart = { model.organizeTrack(track.id) },
	)
	val gestures = LocalPageGestures.current
	val open = { push(Screen.TrackActions(track.id)) }

	if (landscape) {
		Landscape(track, analysis, peaks, skin, model::setSkin, grid, position, duration, zoom, transport, back, open,
			onZoom = { factor -> zoom = (zoom * factor).coerceIn(2f, 64f) },
			onCycleZoom = { zoom = ZOOMS.firstOrNull { it > zoom + 0.01f } ?: ZOOMS.first() },
			onScrub = { scrub = it }, onCallOff = { scrub = null }, onSeek = seek)
	} else {
		val bands = remember(track) { coverBands(track.title, track.artist, track.album, track.bpm, track.key, track.label, track.genre, track.released) }
		val scores = analysisScores(metrics.power(track.power), metrics.brightness(track.brightness), metrics.density(track.density))
		val pictures = model.pictures
		val label = track.label?.trim()?.takeIf { it.isNotEmpty() }
		LaunchedEffect(track.id, artists) { if (artists.isNotEmpty() || label != null) pictures.want(track.id, artists.map { it.name }, label) }
		Portrait(track, bands, analysis, peaks, skin, position, duration, transport,
			scores = scores, uses = uses, people = People(artists, label, pictures::artist, pictures::label),
			playingFrom = if (ours) player.track?.service?.id else track.source,
			from = listName?.name, index = screen.index, count = screen.count,
			back = back, openActions = open,
			openUses = { sets -> push(Screen.TrackUses(track.id, sets)) },
			openArtist = { push(Screen.TrackList(ListSource.Artist(it.id))) },
			openLabel = { push(Screen.TrackList(ListSource.Label(it))) },
			onScrub = { scrub = it }, onCallOff = { scrub = null }, onSeek = seek,
			modifier = Modifier.swipeToOpen(gestures) { Screen.TrackActions(track.id) })
	}
}

/**
 * Where the open track's playback is: each frame while it plays, when
 * [everyFrame] (the big wave moves with it), else a few times a second.
 */
@Composable
private fun rememberPlayhead(player: Player, trackId: String, everyFrame: Boolean): State<Double> {
	val state by player.state.collectAsState()
	val ours = state.track?.trackId == trackId
	val at = remember(player, trackId) { mutableDoubleStateOf(if (ours) player.position.value else 0.0) }
	LaunchedEffect(player, trackId, ours, state.playing, everyFrame) {
		when {
			!ours -> at.doubleValue = 0.0
			// The frame's own time, not this call's: how late in the frame it runs would show as jitter.
			everyFrame && state.playing -> while (true) withFrameNanos { frame ->
				at.doubleValue = player.positionAt(SystemClock.elapsedRealtimeNanos() - (System.nanoTime() - frame))
			}
			else -> player.position.collect { at.doubleValue = it }
		}
	}
	return at
}

/** A text of the position: recomposed when the text changes, not with every frame of it. */
@Composable
internal fun Ticking(text: () -> String, content: @Composable (String) -> Unit) {
	val now by rememberUpdatedState(text)
	val shown by remember { derivedStateOf { now() } }
	content(shown)
}

/** The waveform style: a swatch of the one on, opening the list. */
@Composable
private fun SkinPicker(skin: WaveSkin, onPick: (WaveSkin) -> Unit) {
	PopupMenuAnchor(WaveSkin.entries.map { it.label }, skin.ordinal, { onPick(WaveSkin.entries[it]) }) { open ->
		Box(
			Modifier.size(56.dp, 44.dp).clickable(role = Role.Button, onClick = open).semantics { contentDescription = "Waveform style: ${skin.label}" },
			contentAlignment = Alignment.Center,
		) { SkinSwatch(skin, Modifier.size(44.dp, 24.dp).background(C.bg1)) }
	}
}

@Composable
private fun Boxed(text: String, label: String, w: Dp, h: Dp, mono: Boolean = false, onClick: () -> Unit) {
	Box(
		Modifier.size(w, h).border(1.dp, C.line).clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { BasicText(text, style = if (mono) T.mono(12.5.sp, C.fg1) else T.of(13.sp, color = C.fg1), maxLines = 1, softWrap = false) }
}

@Composable
private fun Landscape(
	t: Track, a: TrackAnalysis, peaks: Peaks?, skin: WaveSkin, onSkin: (WaveSkin) -> Unit, grid: GridShow,
	position: () -> Double, duration: Double, zoom: Float, tr: Transport,
	back: () -> Unit, openActions: () -> Unit, onZoom: (Float) -> Unit, onCycleZoom: () -> Unit,
	onScrub: (Double) -> Unit, onCallOff: () -> Unit, onSeek: (Double) -> Unit,
) {
	val span = windowSec(a.beats, t.bpm, zoom)
	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 8.dp)) {
		Row(Modifier.fillMaxWidth().height(46.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			IconButton(Icon.Back, "Back to portrait", size = 20.dp, onClick = back)
			Cover(t.coverUrl, t.id, 30.dp)
			Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Line(t.title, T.of(15.sp, 500, C.fg), Modifier.weight(1f, fill = false))
				Line(listOf(t.artist, t.label).filter { !it.isNullOrEmpty() }.joinToString(" · "), T.of(13.5.sp, color = C.fg2), Modifier.weight(1f, fill = false))
			}
			BasicText(formatBpm(t.bpm, 1), style = T.mono(14.sp, C.fg))
			KeyChip(t.key, height = 20.dp, fontSize = 12.5f)
			// The track's power tag (p1–p5), when it carries one.
			t.tags.firstOrNull { Regex("^p\\d$").matches(it) }?.let { BasicText(it, style = T.mono(12.5.sp, C.fg2)) }
			SkinPicker(skin, onSkin)
			IconButton(Icon.Menu, "Track actions", tint = C.fg, onClick = openActions)
		}
		androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().height(192.dp)) {
			BigWave(peaks, skin, position, duration, a.beats, a.downbeats, span, grid, a.cues, a.phrases,
				Modifier.fillMaxSize().semantics { contentDescription = "Waveform, ${zoom.toInt()} bars around the playhead. Drag to scrub" },
				onScrub = onScrub, onCallOff = onCallOff, onSeek = onSeek, onZoom = onZoom)
			// Just right of the centre playhead, over the bar numbers' row.
			Ticking({ readout(a.beats, a.downbeats, a.phrases, position()) ?: "" }) {
				if (it.isNotEmpty()) BasicText(it, Modifier.padding(start = maxWidth / 2 + 6.dp, top = 4.dp).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 4.dp, vertical = 1.dp), style = T.mono(11.sp, C.fg))
			}
		}
		OverviewMap(
			peaks, skin, duration, position, a.cues,
			Modifier.fillMaxWidth().height(42.dp).padding(top = 0.dp).semantics { contentDescription = "Track overview. The box is the window above" },
			windowSec = span, badge = androidx.compose.ui.geometry.Size(13f, 12f),
			onScrub = onScrub, onCallOff = onCallOff, onSeek = onSeek,
		)
		Row(Modifier.fillMaxWidth().weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			Ticking({ formatTime(position()) }) { BasicText(it, Modifier.width(64.dp), style = T.mono(13.sp, C.fg)) }
			Spacer(Modifier.weight(1f))
			Boxed("-16", "Back 16 beats", 52.dp, 44.dp, mono = true) { tr.onJump(-16) }
			Boxed("-4", "Back 4 beats", 48.dp, 44.dp, mono = true) { tr.onJump(-4) }
			Boxed("Cue", "Cue", 56.dp, 44.dp) { tr.onCue() }
			Box(
				Modifier.size(64.dp, 44.dp).background(C.fg).clickable(role = Role.Button, onClick = tr.onPlay).semantics { contentDescription = if (tr.playing) "Pause" else "Play" },
				contentAlignment = Alignment.Center,
			) { IconGlyph(if (tr.playing) Icon.Pause else Icon.Play, Color.Black, 20.dp) }
			Boxed("+4", "Forward 4 beats", 48.dp, 44.dp, mono = true) { tr.onJump(4) }
			Boxed("+16", "Forward 16 beats", 52.dp, 44.dp, mono = true) { tr.onJump(16) }
			Boxed("${zoom.toInt()} bars", "Zoom: ${zoom.toInt()} bars. Tap to change", 68.dp, 44.dp) { onCycleZoom() }
			Spacer(Modifier.weight(1f))
			Ticking({ "-" + formatTime(duration - position()) }) {
				BasicText(it, Modifier.width(64.dp), style = T.mono(13.sp, C.fg2).copy(textAlign = androidx.compose.ui.text.style.TextAlign.End))
			}
		}
	}
}
