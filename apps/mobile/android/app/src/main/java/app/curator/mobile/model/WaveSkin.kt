package app.curator.mobile.model

import kotlin.math.max

/** How the big wave's bands become a shape. */
enum class WaveModel { OVERLAP, STACKED, SPECTRUM, ENVELOPE }

/** How the whole-track map draws them (the desktop's mini wavemap). */
enum class MapModel { STACKED, SPECTRUM, ENVELOPE, NESTED }

data class Oklch(val l: Float, val c: Float, val h: Float)

/** A skin's phrase lane: one hue from [lo] to [hi] by intensity, [accent] kept for drops and choruses. */
data class PhraseRamp(val lo: Oklch, val hi: Oklch, val accent: Oklch)

/**
 * The waveform styles, the desktop's own (renderer/renderers/waveformStyles.ts,
 * which says where each look comes from; keep the numbers in step). One choice
 * for every wave on the phone, kept per device as the desktop keeps it.
 * Colours are ARGB; gains are [bass, mid, treble] of the bar height after
 * [gamma]; [mapGains] replace them in the map.
 */
enum class WaveSkin(
	val id: String,
	val label: String,
	val bass: Int,
	val mid: Int,
	val treble: Int,
	val model: WaveModel,
	val map: MapModel,
	val gamma: Float,
	val gains: List<Float>,
	val mapGains: List<Float>,
	val smoothWindow: Int,
	val ramp: PhraseRamp,
	/** Painted where bass and mid overlap, as rekordbox fakes it (OVERLAP only). */
	val blend: Int? = null,
) {
	REKORDBOX(
		"rekordbox", "Blue-Orange-White", 0xFF2053D9.toInt(), 0xFFF2AA3C.toInt(), 0xFFFFFFFF.toInt(),
		WaveModel.OVERLAP, MapModel.STACKED, 0.45f, listOf(1f, 0.75f, 0.15f), listOf(0.49f, 0.32f, 0.25f), 3,
		PhraseRamp(Oklch(0.275f, 0.012f, 62f), Oklch(0.520f, 0.034f, 62f), Oklch(0.745f, 0.135f, 64f)),
		blend = 0xFFA96B27.toInt(),
	),
	TRAKTOR(
		"traktor", "Heat-Map", 0xFFFF0000.toInt(), 0xFF00FF00.toInt(), 0xFF0000FF.toInt(),
		WaveModel.SPECTRUM, MapModel.SPECTRUM, 0.55f, listOf(1f, 1.3f, 1.3f), listOf(1f, 1.3f, 1.3f), 1,
		PhraseRamp(Oklch(0.275f, 0.022f, 320f), Oklch(0.510f, 0.062f, 322f), Oklch(0.770f, 0.155f, 345f)),
	),
	ABLETON(
		"ableton", "Golden", 0xFFE5C100.toInt(), 0xFFE5C100.toInt(), 0xFFE5C100.toInt(),
		WaveModel.ENVELOPE, MapModel.ENVELOPE, 0.7f, listOf(1f, 1f, 1f), listOf(1f, 1f, 1f), 3,
		PhraseRamp(Oklch(0.290f, 0.014f, 82f), Oklch(0.560f, 0.058f, 82f), Oklch(0.805f, 0.135f, 86f)),
	),
	CURATOR(
		"curator", "Silver", 0xFF6E7378.toInt(), 0xFFA8ADB2.toInt(), 0xFFDDE2E7.toInt(),
		WaveModel.STACKED, MapModel.NESTED, 0.55f, listOf(0.7f, 0.22f, 0.12f), listOf(1f, 1.15f, 1.25f), 1,
		PhraseRamp(Oklch(0.290f, 0.005f, 250f), Oklch(0.520f, 0.010f, 250f), Oklch(0.780f, 0.020f, 250f)),
	);

	/** A phrase's colour in the lane under the wave. */
	fun phrase(label: String): Oklch {
		val e = PHRASE_ENERGY[label] ?: 0.30f
		if (e >= PHRASE_PEAK) return ramp.accent
		val t = e / PHRASE_PEAK
		return Oklch(ramp.lo.l + (ramp.hi.l - ramp.lo.l) * t, ramp.lo.c + (ramp.hi.c - ramp.lo.c) * t, ramp.lo.h)
	}

	companion object {
		/** The desktop's default. */
		val DEFAULT = REKORDBOX

		fun of(id: String?): WaveSkin = entries.firstOrNull { it.id == id } ?: DEFAULT
	}
}

/** The Golden skin's inner body where the file has no rms: this much of the peak. */
const val ENVELOPE_BODY = 0.55f

/** A column's colour in the Heat-Map skin: the bands' colours mixed by how loud each is, brightened to full. Null when silent. */
fun spectrumColor(skin: WaveSkin, bass: Float, mid: Float, treble: Float): Int? {
	fun mix(shift: Int) = bass * (skin.bass ushr shift and 0xff) + mid * (skin.mid ushr shift and 0xff) + treble * (skin.treble ushr shift and 0xff)
	val r = mix(16)
	val g = mix(8)
	val b = mix(0)
	val top = max(r, max(g, b))
	if (top <= 0f) return null
	fun channel(v: Float) = (v / top * 255).toInt()
	return (0xff shl 24) or (channel(r) shl 16) or (channel(g) shl 8) or channel(b)
}

// A label's place on its skin's ramp, for the analyzer's labels and
// rekordbox's (desktop phraseRamp.ts).
private const val PHRASE_PEAK = 0.90f
private val PHRASE_ENERGY = mapOf(
	"intro" to 0.16f, "breakdown" to 0.22f, "main" to 0.55f, "build" to 0.72f, "drop" to 1f, "outro" to 0.18f, "unknown" to 0.30f,
	"Intro 1" to 0.16f, "Intro 2" to 0.22f, "Up 1" to 0.45f, "Up 2" to 0.62f, "Up 3" to 0.80f, "Down" to 0.30f,
	"Chorus 1" to 1f, "Chorus 2" to 1f, "Outro 1" to 0.20f, "Outro 2" to 0.18f,
	"Intro" to 0.18f, "Outro" to 0.18f, "Verse 1" to 0.45f, "Verse 2" to 0.50f, "Verse 3" to 0.55f, "Verse 4" to 0.55f,
	"Verse 5" to 0.55f, "Verse 6" to 0.55f, "Bridge" to 0.40f, "Chorus" to 1f,
)
