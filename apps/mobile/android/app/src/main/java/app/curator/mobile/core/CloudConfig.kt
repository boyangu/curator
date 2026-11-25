package app.curator.mobile.core

import android.content.Context
import app.curator.mobile.BuildConfig
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * The cloud this phone signs in to: baked into the build, as the desktop's.
 * A development build takes another from dev-server.json, which run.mjs
 * pushes: the local test server (research/mobile/sync-core-spike/scripts/
 * serve-cloud.ts, the real API with a stand-in for Supabase) through
 * `adb reverse`. A released build never reads that file: whoever can write it
 * could have the sign-in send its password anywhere.
 */
@Serializable
data class CloudConfig(val apiUrl: String, val supabaseUrl: String, val publishableKey: String) {
	companion object {
		private val json = Json { ignoreUnknownKeys = true }

		/** Null: this build was made without one. */
		fun read(context: Context): CloudConfig? {
			if (BuildConfig.DEV_SERVER) {
				val f = File(context.getExternalFilesDir(null), "dev-server.json")
				if (f.exists()) runCatching { json.decodeFromString(serializer(), f.readText()) }.getOrNull()?.let { return it }
			}
			val c = CloudConfig(BuildConfig.CLOUD_API_URL, BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_PUBLISHABLE_KEY)
			return c.takeIf { it.apiUrl.isNotEmpty() && it.supabaseUrl.isNotEmpty() && it.publishableKey.isNotEmpty() }
		}
	}
}
