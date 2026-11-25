package app.curator.mobile.ui.settings

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
import app.curator.mobile.MainActivity
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

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
