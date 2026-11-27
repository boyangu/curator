package app.curator.mobile.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * The stores' and services' small marks, in their own colours: the desktop's
 * marks (apps/desktop renderer/features/brandIcons.ts) drawn shape for shape
 * on the same 24-unit box, plus a plain "MB" monogram for MusicBrainz, which
 * has no mark there. A provider without one gets none.
 */

private sealed interface Mark {
	class Circle(val cx: Float, val cy: Float, val r: Float, val color: Long, val stroke: Float = 0f) : Mark
	class Box(val x: Float, val y: Float, val w: Float, val h: Float, val rx: Float, val color: Long) : Mark
	class Shape(val d: String, val color: Long, val stroke: Float = 0f) : Mark
}

private fun tile(color: Long) = Mark.Box(1f, 1f, 22f, 22f, 6f, color)
private val beatportBody = listOf(Mark.Shape("M8.5 5v13", 0xFF000000, 2.4f), Mark.Circle(12.6f, 14f, 3.9f, 0xFF000000, 2.4f))

private val MARKS: Map<String, List<Mark>> = mapOf(
	"spotify" to listOf(
		Mark.Circle(12f, 12f, 11f, 0xFF1DB954),
		Mark.Shape("M6.3 9.4c3.7-1.2 8.2-.9 11.5 1", 0xFF000000, 2.1f),
		Mark.Shape("M7 12.8c3-.9 6.6-.6 9.3.9", 0xFF000000, 1.8f),
		Mark.Shape("M7.8 15.9c2.3-.6 4.8-.4 6.9.7", 0xFF000000, 1.5f),
	),
	"tidal" to listOf(
		Mark.Shape("M6 5l3.4 3.4L6 11.8 2.6 8.4z", 0xFFEFEFF2),
		Mark.Shape("M12 5l3.4 3.4L12 11.8 8.6 8.4z", 0xFFEFEFF2),
		Mark.Shape("M18 5l3.4 3.4L18 11.8l-3.4-3.4z", 0xFFEFEFF2),
		Mark.Shape("M12 11.6l3.4 3.4-3.4 3.4-3.4-3.4z", 0xFFEFEFF2),
	),
	"beatport" to listOf(tile(0xFF01FF95)) + beatportBody,
	"beatsource" to listOf(tile(0xFFFF7A00)) + beatportBody,
	"traxsource" to listOf(tile(0xFF0C3C64), Mark.Shape("M6.5 7h11M12 7v11", 0xFFFFFFFF, 2.6f)),
	"bandcamp" to listOf(tile(0xFF629AA9), Mark.Shape("M4.5 16.5h9.5l5.5-9H10z", 0xFFFFFFFF)),
	"soundcloud" to listOf(
		Mark.Circle(12f, 12f, 11f, 0xFFFF5500),
		Mark.Box(4.5f, 12f, 1.8f, 5f, .9f, 0xFFFFFFFF),
		Mark.Box(7.5f, 10.5f, 1.8f, 6.5f, .9f, 0xFFFFFFFF),
		Mark.Box(10.5f, 9f, 1.8f, 8f, .9f, 0xFFFFFFFF),
		Mark.Shape("M13.8 9.6a3.4 3.4 0 0 1 5.9 2.3h.3a2.5 2.5 0 0 1 0 5h-6.2z", 0xFFFFFFFF),
	),
	"youtube" to listOf(Mark.Box(1f, 4f, 22f, 16f, 5f, 0xFFFF0000), Mark.Shape("M10 8.5v7l6-3.5z", 0xFFFFFFFF)),
	"deezer" to listOf(tile(0xFF121216)) + listOf(
		4f to 15f, 4f to 12f, 10f to 15f, 10f to 12f, 10f to 9f, 16f to 15f, 16f to 12f, 16f to 9f, 16f to 6f,
	).map { (x, y) -> Mark.Box(x, y, 4f, 2f, 0f, 0xFFA238FF) },
	"apple" to listOf(tile(0xFFFA243C), Mark.Shape("M15.8 5.2v9.3a2.4 2.4 0 1 1-1.6-2.3V8.5l-4.4 1.1v6.6a2.4 2.4 0 1 1-1.6-2.3V7.1z", 0xFFFFFFFF)),
	"musicbrainz" to listOf(tile(0xFF1C1C22), Mark.Shape("M5 17V8l4 4 4-4v9M16 8v9h3.5a2 2 0 0 0 0-4H16m0-5h3a2 2 0 0 1 0 4", 0xFFEFEFF2, 1.6f)),
)

private val parsed = HashMap<String, androidx.compose.ui.graphics.Path>()
private fun pathOf(d: String) = parsed.getOrPut(d) { PathParser().parsePathString(d).toPath() }

fun hasBrandMark(provider: String): Boolean = provider in MARKS

/** The store's display name, as the menus say it ("Open in Apple Music"). */
fun brandName(provider: String): String = when (provider) {
	"spotify" -> "Spotify"
	"tidal" -> "Tidal"
	"beatport" -> "Beatport"
	"beatsource" -> "Beatsource"
	"traxsource" -> "Traxsource"
	"bandcamp" -> "Bandcamp"
	"soundcloud" -> "SoundCloud"
	"youtube" -> "YouTube"
	"deezer" -> "Deezer"
	"apple" -> "Apple Music"
	"musicbrainz" -> "MusicBrainz"
	"discogs" -> "Discogs"
	else -> provider.replaceFirstChar { it.uppercase() }
}

@Composable
fun BrandMark(provider: String, size: Dp = 22.dp, modifier: Modifier = Modifier) {
	val marks = MARKS[provider] ?: return
	Canvas(modifier.size(size)) {
		val s = this.size.minDimension / 24f
		scale(s, s, pivot = Offset.Zero) { for (m in marks) draw(m) }
	}
}

private fun DrawScope.draw(m: Mark) {
	when (m) {
		is Mark.Circle ->
			if (m.stroke > 0f) drawCircle(Color(m.color), m.r, Offset(m.cx, m.cy), style = Stroke(m.stroke))
			else drawCircle(Color(m.color), m.r, Offset(m.cx, m.cy))
		is Mark.Box -> drawRoundRect(Color(m.color), Offset(m.x, m.y), Size(m.w, m.h), CornerRadius(m.rx, m.rx))
		is Mark.Shape ->
			if (m.stroke > 0f) drawPath(pathOf(m.d), Color(m.color), style = Stroke(m.stroke, cap = StrokeCap.Round, join = StrokeJoin.Round))
			else drawPath(pathOf(m.d), Color(m.color))
	}
}
