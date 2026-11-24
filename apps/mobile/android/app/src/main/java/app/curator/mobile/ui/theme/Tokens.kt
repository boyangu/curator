package app.curator.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import app.curator.mobile.R
import kotlin.math.cos
import kotlin.math.sin

/**
 * The design system's tokens (Curator, synced from the desktop's
 * renderer/style.css). Dark only. oklch values convert through Compose's own
 * Oklab space, so they are the design's colours, not approximations.
 */
fun oklch(l: Float, c: Float, hDeg: Float, alpha: Float = 1f): Color {
	val h = Math.toRadians(hDeg.toDouble())
	return Color(l, (c * cos(h)).toFloat(), (c * sin(h)).toFloat(), alpha, ColorSpaces.Oklab).convert(ColorSpaces.Srgb)
}

object C {
	val bg = Color(0xFF0A0A0B)
	val bg1 = Color(0xFF0F0F11)
	val bg2 = Color(0xFF15151A)
	val bg3 = Color(0xFF1C1C22)
	val line = Color(0xFF232329)
	val lineSoft = Color(0xFF1A1A1F)
	val fg = Color(0xFFEFEFF2)
	val fg1 = Color(0xFFD6D6DC)
	val fg2 = Color(0xFFADADB6)
	/** Icons and placeholders only, never text that must be read. */
	val fg3 = Color(0xFF5C5C66)
	/** Decorative only: disabled glyphs, dashed borders. */
	val fg4 = Color(0xFF3A3A42)
	val accent = oklch(0.82f, 0.15f, 210f)
	/** Selected fill; always with a 2dp accent bar or a 1dp accent border. */
	val accentDim = oklch(0.82f, 0.15f, 210f, 0.14f)
	val buy = oklch(0.82f, 0.18f, 145f)
	val hot = oklch(0.72f, 0.20f, 25f)
	val spotify = oklch(0.72f, 0.20f, 145f)
	val rekord = oklch(0.78f, 0.18f, 30f)
	val tidal = fg
	val local = fg2
	val onAccent = Color.Black

	// Waveform, the "Silver" skin (desktop renderers/waveformStyles.ts).
	val waveBass = Color(0xFF6E7378)
	val waveMid = Color(0xFFA8ADB2)
	val waveTreble = Color(0xFFDDE2E7)
	val played = Color(0x99000000)

	// Phrase lane.
	val phraseCalm = oklch(0.70f, 0.06f, 230f)	// intro, break, outro
	val phraseBuild = oklch(0.75f, 0.10f, 90f)
	val phraseDrop = oklch(0.75f, 0.15f, 40f)
}

/** The source dot of a playlist or a track's source. */
fun sourceColor(source: String?): Color = when (source) {
	"spotify" -> C.spotify
	"tidal" -> C.tidal
	"rekordbox", "local" -> C.rekord
	else -> C.local
}

fun sourceName(source: String?): String = when (source) {
	"spotify" -> "Spotify"
	"tidal" -> "Tidal"
	// The owned library, whichever of the two brought the file or playlist in.
	"rekordbox", "local" -> "Owned"
	else -> "Library"
}

/**
 * The key chip's fill: Camelot only, hue (n-1)×30°, A keys lighter and less
 * saturated than B keys. Null for a value that is not Camelot.
 */
fun keyChipColor(camelot: String?): Color? {
	val m = camelot?.let { Regex("^(\\d{1,2})([AB])$").find(it.trim().uppercase()) } ?: return null
	val n = m.groupValues[1].toInt().takeIf { it in 1..12 } ?: return null
	return if (m.groupValues[2] == "A") oklch(0.86f, 0.09f, (n - 1) * 30f) else oklch(0.80f, 0.17f, (n - 1) * 30f)
}

/**
 * rekordbox's 16-colour cue palette, by the opaque `cti:N` ids Curator
 * stores (apps/rekordbox palette.py); anything else takes the fallback.
 */
object CuePalette {
	private val byCti = mapOf(
		49 to 0xFFE045D6, 56 to 0xFFA347E5, 60 to 0xFFC085F2, 62 to 0xFF5878F0,
		1 to 0xFF3690EC, 5 to 0xFF34B5E0, 9 to 0xFF2BC8D9, 14 to 0xFF2A988C,
		18 to 0xFF33B860, 22 to 0xFF7DC430, 26 to 0xFFA4C432, 30 to 0xFFB5AC32,
		32 to 0xFFB59332, 38 to 0xFFE26832, 42 to 0xFFE22832, 45 to 0xFFE22885,
	)
	private val fallback = Color(0xFFFF9028)

	fun color(id: String?): Color {
		val cti = id?.removePrefix("cti:")?.toIntOrNull() ?: return fallback
		return byCti[cti]?.let { Color(it) } ?: fallback
	}
}

object Fonts {
	// Inter is one variable file; each weight is a named instance of it.
	@OptIn(ExperimentalTextApi::class)
	private fun inter(weight: Int) = Font(R.font.inter, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
	val sans = FontFamily(inter(400), inter(500), inter(600), inter(700))
	val mono = FontFamily(Font(R.font.ibm_plex_mono_regular, FontWeight.Normal), Font(R.font.ibm_plex_mono_medium, FontWeight.Medium))
}

/** Type: sentence case everywhere, no uppercase; tabular numerals in mono. */
object T {
	private fun sans(size: TextUnit, weight: Int = 400, color: Color = C.fg1) = TextStyle(fontFamily = Fonts.sans, fontSize = size, fontWeight = FontWeight(weight), color = color)

	val label = sans(12.sp, 500, C.fg2)
	val body = sans(14.sp)
	val secondary = sans(13.sp, color = C.fg2)
	val rowTitle = sans(15.sp, color = C.fg)
	val screenTitle = sans(19.sp, 500, C.fg)
	val trackTitle = sans(21.sp, 600, C.fg)

	fun of(size: TextUnit, weight: Int = 400, color: Color = C.fg1) = sans(size, weight, color)
	fun mono(size: TextUnit, color: Color = C.fg1, weight: Int = 400) = TextStyle(fontFamily = Fonts.mono, fontSize = size, fontWeight = FontWeight(weight), color = color, fontFeatureSettings = "tnum")
}
