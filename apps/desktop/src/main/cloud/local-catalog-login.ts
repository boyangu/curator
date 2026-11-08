// Development only (CURATOR_CATALOG_API_URL): the desktop's Spotify access
// token, sent to the local Global Catalog so it can read followed playlists.
// Spotify serves a playlist's tracks to a person's login, not to an app, and
// the grant the cloud reads them with is not on the local server. Core stays
// the one owner of the login: it refreshes, the local server only borrows.
//
// Loopback only, so a mistyped CURATOR_CATALOG_API_URL can never send a token
// across a network. Re-sent every minute: core refreshes a token a minute
// before it expires, and the server drops one it has not heard about lately.

const EVERY_MS = 60_000;

export function isLoopbackUrl(url: string): boolean {
	try {
		return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
	} catch {
		return false;
	}
}

export function shareSpotifyLogin(
	localBaseUrl: string,
	token: () => Promise<string | null>,
	fetchFn: typeof fetch = fetch,
): () => void {
	if (!isLoopbackUrl(localBaseUrl)) return () => {};
	const send = async (): Promise<void> => {
		try {
			await fetchFn(`${localBaseUrl}/local/spotify-user-token`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accessToken: await token() }),
				signal: AbortSignal.timeout(5_000),
			});
		} catch {
			// The local server is not running, or Spotify is not connected: the
			// next tick tries again.
		}
	};
	void send();
	const timer = setInterval(() => void send(), EVERY_MS);
	timer.unref();
	return () => clearInterval(timer);
}
