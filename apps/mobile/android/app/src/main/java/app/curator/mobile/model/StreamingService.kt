package app.curator.mobile.model

/**
 * The streaming services a library holds tracks from (StreamingService in
 * @curator/shared). The one picked in Settings is where the library's own
 * files play from on this phone, as the Spotify or Tidal track their
 * recording claims. [playable]: whether this phone can play through it yet.
 * Tidal can't: its app lets another app pause, resume and seek it, but not
 * start a chosen track, and its Player SDK gives third-party apps 30-second
 * previews (probed 2026-11-24). It shows as coming soon.
 */
enum class StreamingService(val id: String, val label: String, val playable: Boolean) {
	SPOTIFY("spotify", "Spotify", true),
	TIDAL("tidal", "Tidal", false);

	companion object {
		val DEFAULT = SPOTIFY

		fun of(id: String?): StreamingService? = entries.firstOrNull { it.id == id }

		/** The service Settings has picked: a stored one that can't play (yet) falls back to the default. */
		fun picked(id: String?): StreamingService = of(id)?.takeIf { it.playable } ?: DEFAULT

		/** A streaming track plays from its own service; a file (or anything else) from the [main] one. */
		fun forTrack(source: String?, main: StreamingService): StreamingService = of(source) ?: main
	}
}
