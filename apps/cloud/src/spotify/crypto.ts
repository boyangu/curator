// Sealing the Spotify tokens at rest (sql/0010_spotify_grant.sql): AES-256-GCM
// under a key that lives in a Fly secret (CURATOR_TOKEN_KEY), never in the
// database, so a dump or a Supabase backup alone opens nothing.
//
// Layout of a sealed value: version (1 byte) | IV (12) | ciphertext | tag (16).
// A fresh random IV per seal: GCM's one hard rule is never reusing an IV under
// a key, and at a few seals per user per hour a 96-bit random IV is far from
// the birthday bound.
//
// The AAD binds each value to its user and its field, so a row's bytes copied
// into another account, or the access column copied into the refresh column,
// fail authentication instead of decrypting.
//
// Rotation: the row records the id of the key that sealed it (`key_id`). Opening
// tries that key, current or previous (CURATOR_TOKEN_KEY_PREV); sealing always
// uses the current one, and every write re-seals both columns, so a grant moves
// to the new key on its next refresh. The id is a fingerprint of the key
// itself, so there is no second value to keep in step with it.
//
// Never log a plaintext, a key, or a sealed value.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type TokenPurpose = 'refresh' | 'access';

export type TokenKey = { id: string; key: Buffer };
export type TokenKeyring = { current: TokenKey; previous: TokenKey | null };

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class TokenKeyError extends Error {
	override readonly name = 'TokenKeyError';
}

// The sealed value is unusable: sealed by a key this server no longer holds
// (rotated twice since), tampered with, or moved from another row or column.
export class TokenOpenError extends Error {
	override readonly name = 'TokenOpenError';
}

// A truncated SHA-256 of the key: enough to tell keys apart, nothing about the
// key itself (it is 256 random bits).
export function tokenKeyId(key: Buffer): string {
	return 'k1:' + createHash('sha256').update('curator.token-key:').update(key).digest('hex').slice(0, 16);
}

// A secret as `flyctl secrets` holds it: 32 bytes, base64 (standard or url).
// The message names the variable, never the value.
export function parseTokenKey(name: string, value: string): TokenKey {
	const v = value.trim();
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) throw new TokenKeyError(`${name} is not base64 (value not shown)`);
	const key = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	if (key.length !== KEY_BYTES) throw new TokenKeyError(`${name} must be ${KEY_BYTES} bytes of base64, got ${key.length} (value not shown)`);
	return { id: tokenKeyId(key), key };
}

function aad(userId: string, purpose: TokenPurpose): Buffer {
	return Buffer.from(`curator.spotify_grant/v${VERSION}/${userId.toLowerCase()}/${purpose}`, 'utf8');
}

export class TokenCrypto {
	constructor(private readonly ring: TokenKeyring) {}

	// The `key_id` a row sealed now records.
	get keyId(): string {
		return this.ring.current.id;
	}

	seal(userId: string, purpose: TokenPurpose, plaintext: string): Buffer {
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv('aes-256-gcm', this.ring.current.key, iv);
		cipher.setAAD(aad(userId, purpose));
		const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]);
	}

	open(userId: string, purpose: TokenPurpose, keyId: string, sealed: Buffer): string {
		const key = [this.ring.current, this.ring.previous].find((k) => k?.id === keyId);
		if (!key) throw new TokenOpenError(`no key ${keyId} on this server`);
		if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw new TokenOpenError('not a sealed token');
		const iv = sealed.subarray(1, 1 + IV_BYTES);
		const tag = sealed.subarray(sealed.length - TAG_BYTES);
		const body = sealed.subarray(1 + IV_BYTES, sealed.length - TAG_BYTES);
		try {
			const decipher = createDecipheriv('aes-256-gcm', key.key, iv);
			decipher.setAAD(aad(userId, purpose));
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
		} catch {
			throw new TokenOpenError('sealed token failed authentication');
		}
	}
}
