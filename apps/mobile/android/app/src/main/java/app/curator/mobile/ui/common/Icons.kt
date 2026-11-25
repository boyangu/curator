package app.curator.mobile.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The design's icons: its own 24-unit stroke paths (the canvas artboards),
 * drawn as they are. Decorative: the button around one carries the label.
 */
enum class Icon(val path: String, val filled: Boolean = false) {
	Back("M15 5 8 12l7 7"),
	Menu("M4 7h16M4 12h16M4 17h16"),
	Plus("M12 5v14M5 12h14"),
	Settings("M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"),
	Pin("M12 3v4M8 7h8l-1 6 3 3H6l3-3zM12 16v5"),
	Tag("M3 12V4h8l10 10-8 8zM7.5 7.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 1 0 0-2.6"),
	Home("M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z"),
	Feed("M4 6h16M4 12h11M4 18h7"),
	Library("M5 4v16M10 4v16M15 5l4 15"),
	Explore("M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17M15.5 8.5l-2 5-5 2 2-5z"),
	Search("M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M16 16l4 4"),
	Play("M7 4.5v15l12-7.5z", filled = true),
	Pause("M6 5h4v14H6zM14 5h4v14h-4z", filled = true),
	Next("M16 5h2v14h-2zM4 5v14l11-7z", filled = true),
	Chevron("M9 5l7 7-7 7"),
	Rotate("M3 7h18v10H3zM7 4.5 5 3M17 19.5l2 1.5"),
	Folder("M3 6h6l2 2h10v11H3z"),
	Caret("M7 10l5 5 5-5"),
	Close("M6 6l12 12M18 6 6 18"),
	Heart("M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"),
	HeartFill("M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z", filled = true),
	Share("M12 3.5v11M8 7.5l4-4 4 4M5.5 11.5v8h13v-8"),
	Filter("M4 5h16l-6.2 7.4V18.8l-3.6-1.8v-4.6z"),
	Refresh("M19 12a7 7 0 1 1-2.1-5M19 4v4h-4"),
	Following("M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 0 0 4 2 2 0 1 0 0-4M10 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4"),
}

@Composable
fun IconGlyph(icon: Icon, tint: Color, size: Dp = 22.dp, strokeWidth: Float = 1.7f, modifier: Modifier = Modifier) {
	val path = PathParser().parsePathString(icon.path).toPath()
	Canvas(modifier.size(size)) {
		val s = this.size.minDimension / 24f
		scale(s, s, pivot = androidx.compose.ui.geometry.Offset.Zero) {
			if (icon.filled) drawPath(path, tint, style = Fill)
			else drawPath(path, tint, style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round))
		}
	}
}
