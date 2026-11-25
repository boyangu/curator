package app.curator.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AccountVaultTest {
	@get:Rule val tmp = TemporaryFolder()

	/** Stands in for the Keystore: reversible, and breakable. */
	private class FakeSealer(var lost: Boolean = false) : Sealer {
		override fun seal(plain: ByteArray) = plain.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
		override fun open(sealed: ByteArray): ByteArray {
			check(!lost) { "key lost" }
			return seal(sealed)
		}
	}

	private val account = Account("u1", "a@b.c", Account.Tokens("access-secret", "refresh-secret", 123))

	@Test fun keepsAnAccountAcrossRunsWithItsTokensSealed() {
		val sealer = FakeSealer()
		AccountVault(tmp.root, sealer).write(account)
		assertEquals(AccountVault.State.Kept(account), AccountVault(tmp.root, sealer).read())
		val onDisk = File(tmp.root, "account.json").readText()
		assertFalse("secret" in onDisk)
		assertEquals(listOf("account.json"), tmp.root.list()!!.toList())
	}

	@Test fun forgetsIt() {
		val vault = AccountVault(tmp.root, FakeSealer())
		assertEquals(AccountVault.State.None, vault.read())
		vault.write(account)
		vault.write(null)
		assertEquals(AccountVault.State.None, vault.read())
	}

	@Test fun aLostKeyCostsTheSessionNotTheAccount() {
		val sealer = FakeSealer()
		val vault = AccountVault(tmp.root, sealer)
		vault.write(account)
		sealer.lost = true
		assertEquals(AccountVault.State.Kept(account.copy(tokens = null)), vault.read())
	}

	@Test fun anUnreadableFileIsNotNobody() {
		// Nobody means the library is wiped: never on a bad read.
		File(tmp.root, "account.json").writeText("{ nonsense")
		assertEquals(AccountVault.State.Broken, AccountVault(tmp.root, FakeSealer()).read())
	}
}

class LibraryFilesTest {
	@get:Rule val tmp = TemporaryFolder()

	@Test fun wipeTakesTheLibraryAndLeavesTheRest() {
		val gone = listOf("library.db", "library.db-wal", "library.db-shm", "library.db.replica", "library.db.pre-x.bak", "feed.db", "feed.db-wal", "feed-watches.json", "feed-watches.json.part", "feed-artists.json", "lists.json", "lists.json.part", "library.installed", "peaks/a.cpk")
		val kept = listOf("logs/phone.log", "datastore/view-state.preferences_pb", "libraryx", "feed.dbx")
		for (p in gone + kept) File(tmp.root, p).apply { parentFile!!.mkdirs(); writeText("x") }
		val files = LibraryFiles(tmp.root)
		files.wipe()
		files.wipe()
		for (p in gone) assertFalse(p, File(tmp.root, p).exists())
		for (p in kept) assertTrue(p, File(tmp.root, p).exists())
	}
}
