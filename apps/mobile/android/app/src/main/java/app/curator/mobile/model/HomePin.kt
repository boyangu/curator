package app.curator.mobile.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One entry of the `home.pins` account setting: a tag or a playlist pinned to Home, in order. */
data class HomePin(val kind: String, val id: String) {
	companion object {
		fun toJson(pins: List<HomePin>): JsonArray = JsonArray(pins.map { JsonObject(mapOf("kind" to JsonPrimitive(it.kind), "id" to JsonPrimitive(it.id))) })
	}
}
