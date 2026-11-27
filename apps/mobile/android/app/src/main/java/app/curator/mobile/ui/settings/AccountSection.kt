package app.curator.mobile.ui.settings

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import app.curator.mobile.MainActivity
import app.curator.mobile.core.BeatportProbe
import app.curator.mobile.core.BeatportWebView
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.diag.Uploader
import app.curator.mobile.model.accountNotice
import app.curator.mobile.model.joinNotice
import app.curator.mobile.model.signOutWarning
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.SwitchRow
import app.curator.mobile.ui.common.formatWhen
import app.curator.mobile.ui.list.topLine
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.random.Random

/** Who this phone is signed in as, whether it syncs, and signing out. */
@Composable
fun AccountSection(model: AppModel, signIn: () -> Unit) {
	val account by model.app.account.collectAsState()
	val sync by model.app.core.status.collectAsState()
	val context = LocalContext.current
	var leaving by remember { mutableStateOf(false) }
	val notice = accountNotice(account?.tokens != null, sync?.revoked == true, sync?.needsUpdate == true)
	val pending = sync?.pending ?: 0

	Section("Account") {
		BasicText(account?.email ?: "Signed in", style = T.mono(12.5.sp, C.fg2))
		BasicText(
			notice ?: sync?.error ?: when {
				joinNotice(sync?.waiting == true, sync?.joining == true) != null -> joinNotice(sync?.waiting == true, sync?.joining == true)!!
				pending == 1 -> "1 edit on its way"
				pending > 0 -> "$pending edits on their way"
				else -> "In sync"
			},
			Modifier.semantics { liveRegion = LiveRegionMode.Polite },
			style = T.secondary,
		)
	}
	Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		if (notice != null && sync?.needsUpdate != true) Action("Sign in again", strong = true) { signIn() }
		Action(if (leaving) "Signing out…" else "Sign out", enabled = !leaving) {
			AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
				.setTitle("Sign out of Curator?")
				.setMessage(signOutWarning(pending))
				.setNegativeButton("Cancel", null)
				.setPositiveButton("Sign out") { _, _ ->
					leaving = true
					// The app's scope: the process ends with it.
					model.app.scope.launch { model.app.signOut(MainActivity::class.java) }
				}
				.show()
		}
	}
}

/** Whether this phone sends its log to the account, and the log by hand. */
@Composable
fun Diagnostics(model: AppModel) {
	val on by model.diagnostics.collectAsState()
	val account by model.app.account.collectAsState()
	val state by model.logs.state.collectAsState()
	val context = LocalContext.current

	Section("Diagnostics") {
		BasicText(
			"Sends this app’s log and crashes to your Curator account, where they are kept for 7 days. Never your password, sign-in codes or email.",
			style = T.secondary,
		)
		val line = when (val s = state) {
			Uploader.State.Idle -> null
			Uploader.State.Sending -> "Sending…"
			is Uploader.State.Sent -> "Sent: ${formatWhen(s.at).lowercase()}"
			is Uploader.State.Failed -> s.why
		}
		if (line != null) BasicText(line, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = T.mono(12.5.sp, C.fg2))
	}
	SwitchRow("Allow diagnostics and logs", on, Modifier.fillMaxWidth().heightIn(min = 52.dp)) { model.setDiagnostics(!on) }
	Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		// Sending is the switch's to allow; sharing is the owner's own act.
		if (on && account?.tokens != null) Action("Send logs now") { model.logs.sendNow() }
		Action("Share logs") {
			model.app.scope.launch {
				val file = withContext(Dispatchers.IO) {
					val f = File(context.cacheDir, "logs/curator-log.jsonl").also { it.parentFile?.mkdirs() }
					DiagLog.flushed { it.export(f) }
					f
				}
				val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
				val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
				withContext(Dispatchers.Main) { context.startActivity(Intent.createChooser(send, "Share Curator’s log")) }
			}
		}
	}
	BeatportProbeRow(model)
}

/**
 * The beatport-probe spike's button: reads 30 Beatport pages in a hidden
 * WebView and logs how it went (core/BeatportProbe). It runs while this
 * screen is on the phone's screen only: leaving it, or the app, ends it, and
 * the WebView with it.
 */
@Composable
private fun BeatportProbeRow(model: AppModel) {
	val activity = LocalContext.current as Activity
	val scope = rememberCoroutineScope()
	var job by remember { mutableStateOf<Job?>(null) }
	var line by remember { mutableStateOf<String?>(null) }
	LifecycleEventEffect(Lifecycle.Event.ON_STOP) { job?.cancel() }

	Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
		BasicText("Beatport probe", Modifier.semantics { heading() }, style = T.label)
		BasicText("Reads 30 Beatport pages in a hidden browser and logs how long each took. Nothing in your library changes.", style = T.secondary)
		line?.let { BasicText(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = T.mono(12.5.sp, C.fg2)) }
	}
	Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
		Action(if (job != null) "Running…" else "Run Beatport probe", enabled = job == null) {
			val lib = model.library.value
			if (lib == null) {
				// Diagnostics shows on the sign-in screen too, before there are tracks to search for.
				line = "Open your library first: the searches are its tracks"
				return@Action
			}
			job = scope.launch {
				val reader = BeatportWebView(activity)
				try {
					line = "Picking tracks…"
					val seed = System.currentTimeMillis()
					val tracks = withContext(Dispatchers.IO) { lib.lookupSample(BeatportProbe.SEARCHES, Random(seed)) }
					if (tracks.isEmpty()) {
						line = "No tracks with a title and an artist to search for"
						return@launch
					}
					line = "0/${BeatportProbe.PLANNED} · loading the first page…"
					val s =BeatportProbe.run(activity, reader, tracks, seed) { p ->
						line = "${p.done}/${p.planned} · ${p.parsed} parsed" + (p.medianMs?.let { " · median ${seconds(it)}" } ?: "")
					}
					line = "${s.parsed}/${s.total} parsed · median ${s.medianMs?.let(::seconds) ?: "–"} · p90 ${s.p90Ms?.let(::seconds) ?: "–"} · " +
						"${s.challenged} challenged · ${networkLabel(s.network)}"
					// Up now rather than at the quarter hour, where the owner lets the log go up at all.
					if (model.diagnostics.value && model.app.account.value?.tokens != null) model.logs.sendNow()
				} catch (e: CancellationException) {
					line = "Stopped"
					throw e
				} catch (e: Exception) {
					DiagLog.e("beatport-probe", "the probe failed", e)
					line = "The probe failed: ${e.message}"
				} finally {
					reader.close()
					job = null
				}
			}
		}
	}
}

private fun seconds(ms: Long) = "%.1f s".format(ms / 1000.0)

private fun networkLabel(kind: String) = when (kind) {
	"wifi" -> "Wi-Fi"
	"cellular" -> "mobile data"
	"mixed" -> "network changed during the run"
	else -> "other network"
}

@Composable
private fun Section(title: String, body: @Composable () -> Unit) {
	Column(Modifier.fillMaxWidth().topLine().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
		BasicText(title, Modifier.semantics { heading() }, style = T.label)
		body()
	}
}

/** An outlined button; [strong]: filled, the one action its screen is for. */
@Composable
fun Action(text: String, strong: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
	val shape = RoundedCornerShape(4.dp)
	Box(
		Modifier
			.heightIn(min = 40.dp)
			.alpha(if (enabled) 1f else 0.5f)
			.background(if (strong) C.accent else Color.Transparent, shape)
			.border(1.dp, if (strong) C.accent else C.line, shape)
			.then(if (enabled) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier.semantics { disabled() })
			.padding(horizontal = 14.dp),
		contentAlignment = Alignment.Center,
	) { BasicText(text, style = T.of(14.sp, color = if (strong) Color.Black else C.fg)) }
}
