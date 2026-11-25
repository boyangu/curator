package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInTextTest {
	@Test fun wordsARefusalAndNeverTheStackBehindIt() {
		assertEquals("No connection to Curator’s cloud.", signInProblem("network"))
		assertTrue(signInProblem("invalid_credentials").startsWith("That email and password"))
		val odd = signInProblem("something_new\nat x.ts:1")
		assertEquals("Sign-in failed (something_new).", odd)
	}

	@Test fun noticesWhatNeedsTheOwnerInOrder() {
		assertNull(accountNotice(hasTokens = true, revoked = false, needsUpdate = false))
		assertTrue(accountNotice(hasTokens = false, revoked = true, needsUpdate = true)!!.contains("removed"))
		assertTrue(accountNotice(hasTokens = false, revoked = false, needsUpdate = false)!!.contains("Sign in"))
		assertTrue(accountNotice(hasTokens = true, revoked = false, needsUpdate = true)!!.contains("Update"))
	}

	@Test fun explainsAnEmptyLibraryUntilItIsHere() {
		assertTrue(joinNotice(waiting = true, joining = false)!!.contains("computer"))
		assertTrue(joinNotice(waiting = false, joining = true)!!.contains("Bringing"))
		assertNull(joinNotice(waiting = false, joining = false))
	}

	@Test fun saysWhatSigningOutLoses() {
		assertFalse(signOutWarning(0).contains("edit"))
		assertTrue(signOutWarning(1).contains("1 edit hasn’t"))
		assertTrue(signOutWarning(3).contains("3 edits haven’t"))
	}
}
