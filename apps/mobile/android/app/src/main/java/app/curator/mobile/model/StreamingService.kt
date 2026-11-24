package app.curator.mobile.model

/**
 * The streaming services a library holds tracks from (StreamingService in
 * @curator/shared). The one picked in Settings is where the library's own
 * files play from on this phone, as the Spotify or Tidal track their
 * recording claims. Each plays through its installed app (player/).
 */
enum class StreamingService(val id: String, val label: String) {
	SPOTIFY("spotify", "Spotify"),
	TIDAL("tidal", "Tidal");

	companion object {
		val DEFAULT = SPOTIFY

		fun of(id: String?): StreamingService? = entries.firstOrNull { it.id == id }

		/** A streaming track plays from its own service; a file (or anything else) from the [main] one. */
		fun forTrack(source: String?, main: StreamingService): StreamingService = of(source) ?: main
	}
}
