package app.curator.mobile.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.curator.mobile.model.ListView
import app.curator.mobile.model.StreamingService
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val Context.viewStore by preferencesDataStore("view-state")

/**
 * This device's view state: which lists were opened lately (Home's Recent),
 * each list's sort and filters, Library's pickers, whether the Track view has been turned
 * sideways yet, the streaming service the library's files play from. Per
 * device by design (§3, §5): nothing here rides an op. The streaming service
 * too, as the desktop keeps its primary one (app_setting primary_streaming,
 * not an account setting): what a device can play through is its own.
 * Whether it updates itself, and whether it sends its log, too: each phone's
 * choice.
 */
class ViewState(private val context: Context) {
	private val json = Json { ignoreUnknownKeys = true }
	private val recentKey = stringPreferencesKey("recent")
	private val rotatedKey = booleanPreferencesKey("rotated-once")
	private val streamingKey = stringPreferencesKey("streaming")
	private val autoUpdateKey = booleanPreferencesKey("auto-update")
	private val diagnosticsKey = booleanPreferencesKey("diagnostics")
	private fun listKey(list: String) = stringPreferencesKey("list:$list")

	@Serializable
	data class Recent(val kind: String, val id: String, val at: Long)

	val recent: Flow<List<Recent>> = context.viewStore.data.map { p ->
		p[recentKey]?.let { runCatching { json.decodeFromString<List<Recent>>(it) }.getOrNull() } ?: emptyList()
	}

	suspend fun opened(kind: String, id: String) {
		context.viewStore.edit { p ->
			val now = System.currentTimeMillis()
			val list = p[recentKey]?.let { runCatching { json.decodeFromString<List<Recent>>(it) }.getOrNull() } ?: emptyList()
			p[recentKey] = json.encodeToString(listOf(Recent(kind, id, now)) + list.filterNot { it.kind == kind && it.id == id }.take(MAX_RECENT - 1))
		}
	}

	fun listView(list: String): Flow<ListView> = context.viewStore.data.map { p ->
		p[listKey(list)]?.let { runCatching { json.decodeFromString<ListView>(it) }.getOrNull() } ?: ListView()
	}

	suspend fun setListView(list: String, v: ListView) {
		context.viewStore.edit { it[listKey(list)] = json.encodeToString(v) }
	}

	val rotatedOnce: Flow<Boolean> = context.viewStore.data.map { it[rotatedKey] ?: false }

	suspend fun rotated() {
		context.viewStore.edit { it[rotatedKey] = true }
	}

	/** A remembered choice of a picker (Library's Tracks/Playlists and source): "" when none was made yet. */
	fun pick(name: String): Flow<String> = context.viewStore.data.map { it[stringPreferencesKey("pick:$name")] ?: "" }

	suspend fun setPick(name: String, value: String) {
		context.viewStore.edit { it[stringPreferencesKey("pick:$name")] = value }
	}

	val streaming: Flow<StreamingService> = context.viewStore.data.map { StreamingService.picked(it[streamingKey]) }

	suspend fun setStreaming(s: StreamingService) {
		context.viewStore.edit { it[streamingKey] = s.id }
	}

	/** Install new releases without asking (Updater); on unless turned off. */
	val autoUpdate: Flow<Boolean> = context.viewStore.data.map { it[autoUpdateKey] ?: true }

	suspend fun setAutoUpdate(on: Boolean) {
		context.viewStore.edit { it[autoUpdateKey] = on }
	}

	/** Send this phone's log to the account (diag/Uploader); on unless turned off. */
	val diagnostics: Flow<Boolean> = context.viewStore.data.map { it[diagnosticsKey] ?: true }

	suspend fun setDiagnostics(on: Boolean) {
		context.viewStore.edit { it[diagnosticsKey] = on }
	}

	/** What was seen of a library that is gone from this phone; the phone's own choices stay. */
	suspend fun forgetLibrary() {
		context.viewStore.edit { p ->
			for (k in p.asMap().keys) if (k.name == "recent" || k.name.startsWith("list:") || k.name.startsWith("pick:")) p.remove(k)
		}
	}

	companion object {
		private const val MAX_RECENT = 12
	}
}
