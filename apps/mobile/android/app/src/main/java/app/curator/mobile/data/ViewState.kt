package app.curator.mobile.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.curator.mobile.model.ListView
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val Context.viewStore by preferencesDataStore("view-state")

/**
 * This device's view state: which lists were opened lately (Home's Recent),
 * each list's sort and filters, whether the Track view has been turned
 * sideways yet. Per device by design (§3, §5): nothing here rides an op.
 */
class ViewState(private val context: Context) {
	private val json = Json { ignoreUnknownKeys = true }
	private val recentKey = stringPreferencesKey("recent")
	private val rotatedKey = booleanPreferencesKey("rotated-once")
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

	companion object {
		private const val MAX_RECENT = 12
	}
}
