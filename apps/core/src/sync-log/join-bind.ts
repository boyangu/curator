// The bind sweep: a joining device's own rows onto the recordings the
// account already holds (the 2026-10-22 sync review). Runs once, after the
// bootstrap loaded the account's records and before the join push
// (initial-push.ts joinPushAsync) states what this library alone holds.
//
// Before it, a second desktop with the same files stated every row as a
// recording of its own and left the identity resolver (identity.ts) to merge
// the pairs afterwards: the main library's copy on a laptop was ~35k
// creates, claims and merges on the log for nothing new. With the account's
// claims here first (the snapshot carries them), each row asks the claim
// index who already IS this file or this provider track, and takes that
// recording: no create, no claim, no merge, and the row's tags, cues and
// rating then go up against the recording every device shares.
//
// The rule is the scanner's and the streaming imports' (claim-bind.ts, the
// same ClaimBinder): an exact audio hash, or a Spotify / Tidal track id —
// the same evidence the resolver merges on (never an ISRC or a Beatport id,
// which are judgements, not identity). A row whose recording the records
// already know is left alone: it IS an account recording (a catalogue row
// shared by id, a row this device recorded before sign-in, a row an
// interrupted sweep bound) and a second binding would be a merge, which is
// the resolver's call.
//
// Deleted rows are swept too, but only onto a DELETED recording: a joiner's
// stale soft-delete of its copy must not bind to — and, on the join push,
// delete — the live recording the master still plays (the resolver keeps a
// deleted recording out of a live group for the same reason). A live row
// likewise binds only to a live recording: taking the account's delete onto
// a library the user curated here would be a silent loss on join. Either
// way the row stays its own recording, states itself, and the resolver's
// rules apply from there, exactly as before the sweep existed.
//
// What follows a bind: track.recording_id re-pointed (track_tag, cue,
// playlist_track and the rest key on track_id, so they follow; the
// recording_id trigger marks meta dirty, and the role gate decides whether
// this device restates it), a remote row the snapshot materialised for the
// recording dropped (the own row now speaks for it), and the recording's
// records projected onto the row (projectAdoptedRecordings), as the scanner
// does for a bound file. Pages by rowid with a yield between, each page one
// transaction.

import type Database from 'better-sqlite3';
import { log } from '../log.js';
import { ClaimBinder, projectAdoptedRecordings } from './claim-bind.js';
import { dropRemoteRow } from './remote-rows.js';

type Raw = Database.Database;

const blog = log.for('join-bind');

export const JOIN_BIND_KEY = 'sync.join_bind_at';

export function joinBindDone(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(JOIN_BIND_KEY) !== undefined;
}

export function markJoinBindDone(raw: Raw): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(JOIN_BIND_KEY, JSON.stringify(Date.now()), Date.now());
}

export type JoinBindResult = {
	// Own rows looked at, how many took an account recording (live, and
	// deleted onto deleted), how many already were one, and how many stay
	// their own (nothing claims them, or only the other liveness does).
	rows: number;
	bound: number;
	boundDeleted: number;
	known: number;
	unbound: number;
	// Of the unbound: rows whose recording another own row here already
	// speaks for (a second copy, left to the user).
	held: number;
	chunks: number;
	maxSliceMs: number;
	tracksTouched: string[];
	playlistsTouched: string[];
};

type OwnRow = { rowid: number; id: string; recording_id: string | null; deleted_at: number | null };
type LinkRow = { track_id: string; source: string; source_track_id: string | null; audio_hash: string | null };

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function joinBindAsync(raw: Raw, opts: { page?: number } = {}): Promise<JoinBindResult> {
	const page = Math.max(1, opts.page ?? 400);
	const out: JoinBindResult = { rows: 0, bound: 0, boundDeleted: 0, known: 0, unbound: 0, held: 0, chunks: 0, maxSliceMs: 0, tracksTouched: [], playlistsTouched: [] };
	const rows = raw.prepare(`SELECT rowid, id, recording_id, deleted_at FROM track WHERE rowid > ? AND remote_only = 0 AND derived_from_track_id IS NULL ORDER BY rowid LIMIT ?`);
	const tracks = new Set<string>();
	const playlists = new Set<string>();
	for (let after = 0; ;) {
		const batch = rows.all(after, page) as OwnRow[];
		if (batch.length === 0) break;
		after = batch[batch.length - 1]!.rowid;
		const t0 = performance.now();
		raw.transaction(() => {
			const marks = batch.map(() => '?').join(',');
			const ids = batch.map((r) => r.id);
			const recs = [...new Set(batch.map((r) => r.recording_id).filter((r): r is string => !!r))];
			// Rows whose recording the account knows: left alone (header).
			const known = new Set(recs.length > 0
				? raw.prepare(`SELECT key FROM sync_state WHERE map = 'libraryTracks' AND key IN (${recs.map(() => '?').join(',')})`).pluck().all(...recs) as string[]
				: []);
			const links = new Map<string, LinkRow[]>();
			for (const l of raw.prepare(`SELECT track_id, source, source_track_id, audio_hash FROM source_link
				WHERE track_id IN (${marks}) AND source IN ('local', 'spotify', 'tidal') ORDER BY track_id, source, id`).all(...ids) as LinkRow[]) {
				let list = links.get(l.track_id);
				if (!list) links.set(l.track_id, (list = []));
				list.push(l);
			}
			// One batched claim read per kind for the page (claim-bind.ts).
			const live = new ClaimBinder(raw, { liveOnly: true });
			const any = new ClaimBinder(raw);
			const values = { audio_hash: [] as string[], spotify: [] as string[], tidal: [] as string[] };
			for (const list of links.values()) {
				for (const l of list) {
					if (l.source === 'local' && l.audio_hash) values.audio_hash.push(l.audio_hash);
					else if ((l.source === 'spotify' || l.source === 'tidal') && l.source_track_id) values[l.source].push(l.source_track_id);
				}
			}
			for (const kind of ['audio_hash', 'spotify', 'tidal'] as const) {
				if (values[kind].length === 0) continue;
				live.prefetch(kind, values[kind]);
				any.prefetch(kind, values[kind]);
			}
			const adopted = new Set<string>();
			for (const r of batch) {
				out.rows++;
				if (r.recording_id && known.has(r.recording_id)) { out.known++; continue; }
				const claims: Array<['audio_hash' | 'spotify' | 'tidal', string]> = [];
				for (const l of links.get(r.id) ?? []) {
					if (l.source === 'local' && l.audio_hash) claims.push(['audio_hash', l.audio_hash]);
					else if ((l.source === 'spotify' || l.source === 'tidal') && l.source_track_id) claims.push([l.source, l.source_track_id]);
				}
				let target: string | null = null;
				let taken = false;
				for (const [kind, value] of claims) {
					const b = r.deleted_at === null ? live.bind(kind, value) : any.bind(kind, value);
					if (!b || (r.deleted_at !== null && !b.deleted)) continue;
					// Another own row already speaks for the recording (the user's
					// second copy of a file, kept apart on purpose: identity.ts
					// "held"): this one stays its own, for the user to resolve.
					if (b.trackId && b.trackId !== r.id && raw.prepare(`SELECT remote_only FROM track WHERE id = ?`).pluck().get(b.trackId) === 0) { taken = true; continue; }
					target = b.recordingId;
					break;
				}
				if (!target) { out.unbound++; if (taken) out.held++; continue; }
				// A remote row the snapshot made for the recording gives way to
				// this device's own row, as in a merge (project.ts step 1).
				for (const remote of raw.prepare(`SELECT id FROM track WHERE recording_id = ? AND remote_only = 1`).pluck().all(target) as string[]) {
					for (const p of dropRemoteRow(raw, remote)) playlists.add(p);
				}
				raw.prepare(`UPDATE track SET recording_id = ? WHERE id = ?`).run(target, r.id);
				adopted.add(target);
				tracks.add(r.id);
				if (r.deleted_at === null) out.bound++;
				else out.boundDeleted++;
			}
			if (adopted.size > 0) {
				const s = projectAdoptedRecordings(raw, adopted);
				for (const t of s.tracksTouched) tracks.add(t);
				for (const p of s.playlistsTouched) playlists.add(p);
			}
		})();
		out.chunks++;
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		await yieldToLoop();
	}
	markJoinBindDone(raw);
	out.tracksTouched = [...tracks];
	out.playlistsTouched = [...playlists];
	blog.info('bind sweep done', { rows: out.rows, bound: out.bound, boundDeleted: out.boundDeleted, known: out.known, unbound: out.unbound, held: out.held, chunks: out.chunks, maxSliceMs: Math.round(out.maxSliceMs) });
	return out;
}
