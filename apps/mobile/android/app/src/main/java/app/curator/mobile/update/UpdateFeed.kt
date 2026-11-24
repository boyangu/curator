package app.curator.mobile.update

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The update feed: the repo's GitHub releases tagged mobile-vX.Y.Z, each
 * carrying the signed APK and an update.json naming it (written by
 * scripts/release-mobile.mjs). Read without a token: the repo is public,
 * and a check every few hours stays far below the API's 60 an hour.
 */
object UpdateFeed {
	private val json = Json { ignoreUnknownKeys = true }
	private val TAG = Regex("""^mobile-v(\d+)\.(\d+)\.(\d+)$""")

	/** A release's own description of itself (update.json). */
	@Serializable
	data class Manifest(val version: String, val versionCode: Long, val apk: String, val sha256: String, val size: Long, val commit: String? = null)

	/** The newest published release in the feed: its version code, and where its update.json and assets are. */
	data class Release(val tag: String, val versionCode: Long, val manifestUrl: String, val assets: Map<String, String>, val notesUrl: String?)

	/** As build.gradle.kts orders versions: 1.2.3 → 1_002_003. */
	fun versionCode(major: Int, minor: Int, patch: Int): Long = major * 1_000_000L + minor * 1_000L + patch

	/** The newest mobile release in GitHub's release list, skipping drafts, prereleases and releases without an update.json. */
	fun newest(releasesJson: String): Release? = json.parseToJsonElement(releasesJson).jsonArray.mapNotNull { e ->
		val r = e.jsonObject
		if (r.flag("draft") || r.flag("prerelease")) return@mapNotNull null
		val tag = r["tag_name"]?.jsonPrimitive?.content ?: return@mapNotNull null
		val (major, minor, patch) = TAG.find(tag)?.groupValues?.drop(1)?.map { it.toInt() } ?: return@mapNotNull null
		val assets = r["assets"]?.jsonArray.orEmpty().associate {
			val a = it.jsonObject
			a["name"]!!.jsonPrimitive.content to a["browser_download_url"]!!.jsonPrimitive.content
		}
		val manifest = assets["update.json"] ?: return@mapNotNull null
		Release(tag, versionCode(major, minor, patch), manifest, assets, r["html_url"]?.jsonPrimitive?.content)
	}.maxByOrNull { it.versionCode }

	fun manifest(text: String): Manifest = json.decodeFromString(Manifest.serializer(), text)

	private fun JsonObject.flag(name: String) = this[name]?.jsonPrimitive?.booleanOrNull == true
}
