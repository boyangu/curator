package app.curator.mobile.ui.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.core.CoreRuntime
import app.curator.mobile.model.signInProblem
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.settings.Action
import app.curator.mobile.ui.settings.Diagnostics
import app.curator.mobile.ui.settings.Updates
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.launch

private enum class Way { PASSWORD, CODE, RESET }

/**
 * Signing in to the Curator account, by password or a code sent by email, as
 * on the desktop (accounts are made there). A forgotten password is a code
 * and a new password. On a phone without an account it is the whole app; [back] is there when a library is open and only its session
 * ended.
 *
 * Updates and the log are within reach here too: without a cable they are the
 * way out of a build that can't sign in.
 */
@Composable
fun SignInScreen(model: AppModel, back: (() -> Unit)?) {
	val account by model.app.account.collectAsState()
	val scope = rememberCoroutineScope()
	val focus = LocalFocusManager.current
	var email by rememberSaveable { mutableStateOf(account?.email.orEmpty()) }
	// Not saveable: a password isn't written into the saved state.
	var password by remember { mutableStateOf("") }
	var code by remember { mutableStateOf("") }
	var way by rememberSaveable { mutableStateOf(Way.PASSWORD) }
	// The code was taken, and only the new password is still to be accepted.
	var proven by remember { mutableStateOf(false) }
	var busy by remember { mutableStateOf(false) }
	var problem by remember { mutableStateOf<String?>(null) }

	fun attempt(what: suspend () -> Unit) {
		if (busy) return
		busy = true
		problem = null
		focus.clearFocus()
		scope.launch {
			try {
				what()
			} catch (e: CoreRuntime.CoreError) {
				problem = signInProblem(e.message.orEmpty().lineSequence().first())
			} finally {
				busy = false
			}
		}
	}
	fun signedIn() {
		password = ""
		code = ""
		back?.invoke()
		// Not this screen's scope: it goes as the library opens.
		model.app.scope.launch { model.app.openLibrary() }
	}
	fun submit() = attempt {
		when (way) {
			Way.PASSWORD -> model.signInPassword(email, password)
			Way.CODE -> model.verifyCode(email, code)
			Way.RESET -> {
				// A code works once: a password refused is tried again without it.
				if (!proven) { model.verifyCode(email, code); proven = true }
				model.setPassword(password)
			}
		}
		signedIn()
	}
	fun sendCode(then: Way) = attempt { model.requestCode(email); password = ""; code = ""; proven = false; way = then }

	Column(
		Modifier
			.fillMaxSize()
			.background(C.bg)
			.windowInsetsPadding(WindowInsets.statusBars)
			.windowInsetsPadding(WindowInsets.navigationBars)
			.windowInsetsPadding(WindowInsets.ime)
			.verticalScroll(rememberScrollState()),
	) {
		Row(Modifier.fillMaxWidth().height(56.dp).padding(start = if (back != null) 4.dp else 16.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
			if (back != null) IconButton(Icon.Back, "Back", onClick = back)
			BasicText("Sign in to Curator", Modifier.semantics { heading() }, style = T.screenTitle)
		}
		Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
			BasicText(
				if (back == null) "The account you use in Curator on your computer. Your library is brought to this phone." else "Your library stays as it is; signing in lets it sync again.",
				style = T.secondary,
			)
			Field("Email", email, { email = it }, KeyboardType.Email, ImeAction.Next)
			if (way != Way.PASSWORD) {
				BasicText(if (proven) "The code was right. Choose a password." else "A code was sent to that address. Enter it here; a link in the email, if there is one, doesn’t open this app.", style = T.secondary)
				if (!proven) Field("Code", code, { code = it }, KeyboardType.Number, if (way == Way.RESET) ImeAction.Next else ImeAction.Done) { submit() }
			}
			if (way == Way.RESET) BasicText("Your other devices are signed out with the new password and sign in again with it.", style = T.secondary)
			if (way != Way.CODE) Field(if (way == Way.RESET) "New password" else "Password", password, { password = it }, KeyboardType.Password, ImeAction.Done, secret = true) { submit() }
			problem?.let { BasicText(it, Modifier.semantics { liveRegion = LiveRegionMode.Assertive }, style = T.of(13.sp, color = C.fg)) }
			val filled = email.isNotBlank() && (way == Way.PASSWORD || proven || code.isNotBlank()) && (way == Way.CODE || password.isNotEmpty())
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Action(if (busy) "One moment…" else if (way == Way.RESET) "Set password and sign in" else "Sign in", strong = true, enabled = filled && !busy) { submit() }
				if (way == Way.PASSWORD) Action("Email me a code", enabled = email.isNotBlank() && !busy) { sendCode(Way.CODE) }
				else Action("Back", enabled = !busy) { way = Way.PASSWORD; password = ""; problem = null }
			}
			if (way == Way.PASSWORD) Action("Forgot your password?", enabled = email.isNotBlank() && !busy) { sendCode(Way.RESET) }
		}
		Diagnostics(model)
		Updates(model)
		Spacer(Modifier.height(24.dp))
	}
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, type: KeyboardType, ime: ImeAction, secret: Boolean = false, onDone: () -> Unit = {}) {
	Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
		BasicText(label, style = T.label)
		Box(
			Modifier.fillMaxWidth().heightIn(min = 46.dp).background(C.bg2, RoundedCornerShape(4.dp)).border(1.dp, C.line, RoundedCornerShape(4.dp)).padding(horizontal = 12.dp),
			contentAlignment = Alignment.CenterStart,
		) {
			BasicTextField(
				value,
				onValueChange = onChange,
				modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
				singleLine = true,
				textStyle = T.of(15.sp, color = C.fg),
				cursorBrush = SolidColor(C.accent),
				visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
				keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ime, autoCorrectEnabled = false),
				keyboardActions = KeyboardActions(onDone = { onDone() }),
			)
		}
	}
}

/** Over the player: what the account's library is waiting for; [open]s what helps, where something does. */
@Composable
fun AccountBanner(text: String, open: (() -> Unit)?) {
	Row(
		Modifier.fillMaxWidth().background(C.bg2).padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(8.dp),
	) {
		BasicText(text, Modifier.weight(1f), style = T.of(13.sp, color = C.fg))
		if (open != null) Action("Open") { open() }
	}
}
