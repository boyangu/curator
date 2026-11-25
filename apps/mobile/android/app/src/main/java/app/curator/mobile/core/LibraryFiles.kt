package app.curator.mobile.core

import java.io.File

/** The files of the signed-in account's library on this phone; nothing else in the app's folder is theirs. */
class LibraryFiles(private val dir: File) {
	val db = File(dir, "library.db")
	val feedDb = File(dir, "feed.db")
	val feedWatches = File(dir, "feed-watches.json")
	val feedArtists = File(dir, "feed-artists.json")
	val peaks = File(dir, "peaks")
	val lists = File(dir, "lists.json")

	/** Set once the core has said the library is ready on this device (its install is done). */
	val installed = File(dir, "library.installed")

	/**
	 * Removes the library from this phone. Only before anything opened it: the
	 * process that signed out restarts first (CuratorApp). Running it again
	 * finishes what a killed run left.
	 */
	fun wipe() {
		// First, so a half-wiped library never opens as a whole one.
		installed.delete()
		// The databases with what SQLite, the replica's install and migrate's
		// backups keep beside them; the JSON files with their unfinished copies.
		val own = listOf(db, feedDb, feedWatches, feedArtists, lists).map { it.name }
		dir.listFiles()?.forEach { f -> if (f.isFile && own.any { f.name == it || f.name.startsWith("$it.") || f.name.startsWith("$it-") }) f.delete() }
		peaks.deleteRecursively()
	}
}
