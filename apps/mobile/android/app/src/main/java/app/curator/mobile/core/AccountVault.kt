package app.curator.mobile.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Whose library this phone holds (the core's AuthAccount, js/entry.ts). Without tokens: their session ended, the library is still theirs. */
@Serializable
data class Account(val userId: String, val email: String? = null, val tokens: Tokens? = null) {
	@Serializable
	data class Tokens(val accessToken: String, val refreshToken: String, val expiresAt: Long)
}

/** Seals the session's tokens with a key only this install has. */
interface Sealer {
	fun seal(plain: ByteArray): ByteArray
	fun open(sealed: ByteArray): ByteArray
}

/**
 * The account this phone is signed in to, across runs: a small file, its
 * tokens sealed, in [dir] (never backed up). Who it is stays readable without
 * the key: a key the Keystore lost costs a sign-in, not the library (the boot
 * rule wipes a phone with no account, CuratorApp).
 */
class AccountVault(dir: File, private val sealer: Sealer) {
	sealed interface State {
		/** Nobody is signed in. */
		data object None : State
		data class Kept(val account: Account) : State
		/** There is an account, but what it was can't be read: sign in again. */
		data object Broken : State
	}

	@Serializable
	private data class Stored(val userId: String, val email: String? = null, val sealed: String? = null)

	private val file = File(dir, "account.json")
	private val json = Json { ignoreUnknownKeys = true }

	fun read(): State {
		if (!file.exists()) return State.None
		val s = runCatching { json.decodeFromString<Stored>(file.readText()) }.getOrNull() ?: return State.Broken
		val tokens = s.sealed?.let { runCatching { json.decodeFromString<Account.Tokens>(String(sealer.open(Base64.getDecoder().decode(it)))) }.getOrNull() }
		return State.Kept(Account(s.userId, s.email, tokens))
	}

	/** Keeps [account]; null forgets it. Throws when it can't: a rotated refresh token that isn't kept is a lost session. */
	fun write(account: Account?) {
		if (account == null) {
			file.delete()
			return
		}
		val sealed = account.tokens?.let { Base64.getEncoder().encodeToString(sealer.seal(json.encodeToString(it).toByteArray())) }
		val tmp = File(file.path + ".part")
		tmp.writeText(json.encodeToString(Stored(account.userId, account.email, sealed)))
		Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
	}
}

/** AES-GCM under a key made in, and never leaving, the Android Keystore. */
class KeystoreSealer : Sealer {
	private fun key(): SecretKey {
		val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
		(store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
		return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
			init(
				KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
					.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
					.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
					.setKeySize(256)
					.build(),
			)
			generateKey()
		}
	}

	override fun seal(plain: ByteArray): ByteArray {
		val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
		return c.iv + c.doFinal(plain)
	}

	override fun open(sealed: ByteArray): ByteArray {
		val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV)) }
		return c.doFinal(sealed, IV, sealed.size - IV)
	}

	private companion object {
		const val ALIAS = "curator-account"
		const val IV = 12
	}
}
