package app.curator.mobile.model

/** Why a sign-in didn't work, in words; [code] is the auth client's (sync-core auth/gotrue.ts AuthError). */
fun signInProblem(code: String): String = when (code) {
	"invalid_credentials", "invalid_grant" -> "That email and password don’t match an account."
	"otp_expired", "invalid_otp", "validation_failed" -> "That code is wrong or has expired."
	"over_email_send_rate_limit", "over_request_rate_limit" -> "Too many tries. Wait a minute, then try again."
	"otp_disabled", "signup_disabled", "user_not_found" -> "No Curator account has that email. Accounts are made on the desktop."
	"weak_password" -> "That password is too easy to guess. Use a longer one."
	"same_password" -> "That is the password it already has. Sign in with it, or choose another."
	"reauthentication_needed", "session_not_found" -> "Too much time has passed. Ask for a new code."
	"email_not_confirmed" -> "Confirm the email address first: Curator sent you a link."
	"email_address_invalid" -> "That isn’t an email address."
	"network" -> "No connection to Curator’s cloud."
	"server" -> "Curator’s cloud had a problem. Try again in a moment."
	"other_account" -> "This phone holds another account’s library. Sign out first to change accounts."
	else -> "Sign-in failed (${code.lineSequence().first().take(60)})."
}

/** Why there is little or nothing in a library that was just opened; null once it is here. */
fun joinNotice(waiting: Boolean, joining: Boolean): String? = when {
	joining -> "Bringing your library to this phone. It fills in as it arrives."
	waiting -> "Your library isn’t in the cloud yet. Open Curator on your computer and let it sync."
	else -> null
}

/** What the sync client says about the session, as the banner over the player shows it; null when all is well. */
fun accountNotice(hasTokens: Boolean, revoked: Boolean, needsUpdate: Boolean): String? = when {
	revoked -> "This phone was removed from your account. Sign in to add it back."
	!hasTokens -> "Signed out by the cloud. Sign in to keep syncing."
	needsUpdate -> "Update Curator to keep syncing."
	else -> null
}

/** The sign-out question's body: what of this phone goes. */
fun signOutWarning(pending: Int): String {
	val base = "Your library is removed from this phone. It stays on your account and your computers."
	if (pending == 0) return base
	val edits = if (pending == 1) "1 edit hasn’t" else "$pending edits haven’t"
	return "$base\n\n$edits reached your account yet. Curator tries to send ${if (pending == 1) "it" else "them"} first; without a connection ${if (pending == 1) "it is" else "they are"} lost."
}
