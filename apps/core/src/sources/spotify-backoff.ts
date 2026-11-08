// The Spotify quota-ban deadline, kept in app_setting so it outlives the
// process. The provider (@curator/spotify) owns the ban logic and refuses every
// call until the deadline; this is only where the deadline sleeps between
// runs. Without it, each restart of the desktop re-probed a wall Spotify had
// said would stand for hours, and took another 429 for it.

import type Database from 'better-sqlite3';
import type { SpotifyBackoffStore } from '@curator/spotify';

export const SPOTIFY_BACKOFF_KEY = 'spotify.backoff_until';

export function spotifyBackoffStore(raw: Database.Database): SpotifyBackoffStore {
	return {
		load() {
			const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(SPOTIFY_BACKOFF_KEY) as { value: string } | undefined;
			const until = Number(row?.value);
			return Number.isFinite(until) && until > Date.now() ? until : null;
		},
		save(until) {
			raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
				.run(SPOTIFY_BACKOFF_KEY, String(until), Date.now());
		},
	};
}
