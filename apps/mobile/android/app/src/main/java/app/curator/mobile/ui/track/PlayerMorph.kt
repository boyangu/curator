package app.curator.mobile.ui.track

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntSize
import app.curator.mobile.data.Track
import app.curator.mobile.model.CoverBands
import app.curator.mobile.ui.nav.LocalSheetMotion
import app.curator.mobile.ui.nav.SheetMotion

/**
 * The bar turning into the player, and back: while a sheet raised from the
 * bar (or lowered to it) moves, the bar's cover, title and artists are
 * carried from their places in the bar to theirs on the player's cover,
 * there a fifth of the way up (model SheetDrag.morph); the rest fades.
 *
 * Each side says where its pieces are; the overlay ([MorphOverlay], above
 * the whole stack, as the sheet and its scroll would clip a piece outside
 * them) draws the carried ones, and both sides hide theirs meanwhile. Read
 * while drawing, as the sheet moves every frame.
 */
class PlayerMorph {
	// State, though only drawing reads them: the sheet's pieces are placed a
	// frame after it appears, and a drawing that read them before must redo.
	internal var barCover by mutableStateOf<LayoutCoordinates?>(null)
	internal var barTitle by mutableStateOf<LayoutCoordinates?>(null)
	internal var barArtist by mutableStateOf<LayoutCoordinates?>(null)
	internal var barTrack by mutableStateOf<String?>(null)

	/** The bar's top in the window, as last seen (kept once it is gone): where a sheet lowered to it rests. */
	var barTop: Float? = null
		internal set

	// The player: the sheet's root, then its cover and the cover's title and artists bands.
	internal var sheet by mutableStateOf<LayoutCoordinates?>(null)
	internal var cover by mutableStateOf<LayoutCoordinates?>(null)
	internal var title by mutableStateOf<LayoutCoordinates?>(null)
	internal var artist by mutableStateOf<LayoutCoordinates?>(null)

	/** What the player's cover shows: the overlay draws the same, so the hand-over can't be seen. */
	internal var face by mutableStateOf<Face?>(null)

	/** Whether the bar's pieces are on their way now. */
	fun carrying(m: SheetMotion): Boolean {
		if (!m.moving() || !m.viaBar() || m.step() >= 1f) return false
		if (face?.track?.id != barTrack) return false
		return listOf(barCover, barTitle, sheet, cover, title).all { it?.isAttached == true }
	}
}

internal data class Face(val track: Track, val bands: CoverBands)

val LocalPlayerMorph = staticCompositionLocalOf<PlayerMorph?> { null }

/** The carried pieces, drawn over the stack while the bar turns into the player. */
@Composable
fun MorphOverlay(morph: PlayerMorph) {
	val motion = LocalSheetMotion.current
	val on by remember(motion) { derivedStateOf { morph.carrying(motion) } }
	val face = morph.face
	if (!on || face == null) return
	val here = remember { Here() }
	val density = LocalDensity.current
	fun sized(s: IntSize) = with(density) { Modifier.size(DpSize(s.width.toDp(), s.height.toDp())) }
	Box(Modifier.fillMaxSize().onPlaced { here.at = it }.clearAndSetSemantics {}) {
		val pad = with(density) { Offset(BAND_PAD_X.toPx(), BAND_PAD_Y.toPx()) }
		morph.cover?.let { c ->
			Box(sized(c.size).carried(here, motion, morph, { morph.barCover }, { morph.cover }, Offset.Zero)) {
				BandedCover(face.track, face.bands, fade = motion::step, leads = false)
			}
		}
		val title = face.bands.title
		val t = morph.title
		if (title != null && t != null) Band(title, TITLE, sized(t.size).carried(here, motion, morph, { morph.barTitle }, { morph.title }, pad), bg = motion::step)
		val artists = face.bands.artists
		val a = morph.artist
		if (artists != null && a != null) Band(artists, ARTISTS, sized(a.size).carried(here, motion, morph, { morph.barArtist }, { morph.artist }, pad), bg = motion::step)
	}
}

// The overlay's place, kept as it is placed (not state: only drawing reads it).
private class Here { var at: LayoutCoordinates? = null }

/**
 * Draws a piece (laid out at its size on the player, at the overlay's
 * corner) [SheetMotion.step] of the way from the bar's piece to its place on
 * the rising sheet. At the start its content, inside [inset] (a band's
 * padding), lies over the bar's at the bar's size; a piece whose ends aren't
 * both there isn't drawn.
 */
private fun Modifier.carried(
	here: Here, motion: SheetMotion, morph: PlayerMorph,
	from: () -> LayoutCoordinates?, to: () -> LayoutCoordinates?, inset: Offset,
): Modifier = graphicsLayer {
	val h = here.at
	val a = from()
	val b = to()
	val sheet = morph.sheet
	if (h == null || a == null || b == null || sheet == null || !(h.isAttached && a.isAttached && b.isAttached && sheet.isAttached)) {
		alpha = 0f
		return@graphicsLayer
	}
	alpha = 1f
	val f = motion.step()
	val src = h.localBoundingBoxOf(a, clipBounds = false)
	// On the sheet, as it stands this frame: its top is its height less the reveal below the host's.
	val dst = sheet.localBoundingBoxOf(b, clipBounds = false).translate(0f, motion.height() - motion.reveal())
	val inner = dst.height - 2 * inset.y
	val s0 = if (inner > 0f) src.height / inner else 1f
	val x0 = src.left - inset.x * s0
	val y0 = src.top - inset.y * s0
	val s = s0 + (1f - s0) * f
	transformOrigin = TransformOrigin(0f, 0f)
	scaleX = s
	scaleY = s
	translationX = x0 + (dst.left - x0) * f
	translationY = y0 + (dst.top - y0) * f
}
