package app.curator.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import app.curator.mobile.ui.CuratorUi
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

class MainActivity : ComponentActivity() {
	// Spotify's consent screen, opened for the player and answered back to it.
	private val spotifyConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
		(application as CuratorApp).model.player.onAuthorized(r.resultCode, r.data)
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		enableEdgeToEdge()
		val app = application as CuratorApp
		setContent { CuratorUi(app.model) }
	}

	// In use or not: the sync client polls on its active cadence while the
	// app is on screen (SyncClient.setActive).
	override fun onStart() {
		super.onStart()
		setActive(true)
		// Spotify's consent screen opens over the screen in front.
		(application as CuratorApp).model.player.attach(this) { spotifyConsent.launch(it) }
		(application as CuratorApp).model.updater.onForeground(this)
		(application as CuratorApp).model.logs.onForeground()
	}

	override fun onStop() {
		super.onStop()
		setActive(false)
		(application as CuratorApp).model.player.attach(null, null)
		(application as CuratorApp).model.updater.onBackground()
		(application as CuratorApp).model.logs.onBackground()
	}

	private fun setActive(active: Boolean) {
		val app = application as CuratorApp
		app.scope.launch {
			if (app.core.phase.value == "ready") runCatching { app.core.call("setActive", buildJsonObject { put("active", JsonPrimitive(active)) }) }
		}
	}
}
