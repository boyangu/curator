// PKCE helpers shared by every OAuth provider (Spotify, Google Drive). Built
// on the WebCrypto globals + btoa rather than node:crypto/Buffer so this stays
// importable from the renderer bundle like the rest of the root export.

export function base64url(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = base64url(verifierBytes);
	const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const challenge = base64url(challengeBytes);
	return { verifier, challenge };
}
