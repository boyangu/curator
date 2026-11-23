package app.curator.mobile.core

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Where the phone syncs for now: the local test server (research/mobile/
 * sync-core-spike/scripts/serve-cloud.ts, the real API code on PGlite) through
 * `adb reverse`, as Guy decided for this pass (local testing only). The run
 * script pushes the server's server.json into this app's external files
 * folder. Real sign-in (Supabase) replaces it.
 */
@Serializable
data class DevServer(val apiUrl: String, val userId: String, val token: String) {
	companion object {
		private val json = Json { ignoreUnknownKeys = true }

		fun read(context: Context): DevServer? {
			val f = File(context.getExternalFilesDir(null), "dev-server.json")
			if (!f.exists()) return null
			return runCatching { json.decodeFromString(serializer(), f.readText()) }.getOrNull()
		}
	}
}
