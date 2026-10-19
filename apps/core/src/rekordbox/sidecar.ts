// Node-side manager for the Python rekordbox-reader sidecar.
//
// Mirrors apps/core/src/analyzer/sidecar.ts in shape (spawn, stdio framing,
// id-correlated request/response, EventEmitter for streamed events,
// crash-restart with exponential backoff). The protocol is documented at
// apps/rekordbox/src/curator_rekordbox/main.py; keep both in sync.
//
// Differences from the analyzer sidecar:
//   - Only one scan in flight at a time (sidecar enforces; manager exposes
//     scan() as a serialized async method).
//   - `scan` is an event-stream method: returns the final result, but emits
//     'event' along the way (`track`, `cues`, `playlist`, `mytag`, `waveform`,
//     `progress`) that the importer subscribes to.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { scrubLoneSurrogates } from '@curator/shared';
import { log } from '../log.js';

const rlog = log.for('rekordbox');

export interface SidecarOptions {
	executable: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface OpenParams {
	dbPath: string;
	key?: string;
}

export interface DetectResult {
	dbPath: string | null;
	running: boolean;
}

// Scope identifiers — one per data-class checkbox in Settings → Rekordbox.
// The Python sidecar dispatches passes based on which strings are present
// in scan()'s `scopes` argument. The waveform pass shares its ANLZ load
// across 'cues_grids_phrases' and 'waveform_peaks', so either alone runs
// the relevant half of the work.
export type RekordboxScope =
	| 'tracks'
	| 'playlists'
	| 'mytags'
	// Lightweight DjmdCue-only pass — same cue deltas as
	// 'cues_grids_phrases' but skips the ANLZ beatgrid/phrase/waveform
	// work. Used by the sync pipeline's pull phase (metadata + cues only).
	| 'cues'
	| 'cues_grids_phrases'
	| 'waveform_peaks'
	// DjmdHistory + DjmdSongHistory — play sessions. Read-only, full-scan
	// every pass (no USN on either table); skipped on targeted pulls.
	| 'history';

export interface ScanParams {
	watermarks: Record<string, number>;
	scopes: RekordboxScope[];
	peaksDir?: string;
	// When true, the waveform pass bypasses its per-row .cpk-freshness gate
	// so peaks get re-decoded even when the on-disk file looks current.
	// Pairs with the importer-side LMW bypass on grids/segments writes
	// (which the TS importer applies independently when `overwriteCurator`
	// is set on its RunImportOptions). Used by the "Sync Everything" UI
	// action.
	forceRefreshGrids?: boolean;
	// Scoped "Sync from Rekordbox" targeting. When either is present the
	// reader restricts every pass to these ids — regardless of the USN
	// watermark — and playlist ids expand to their member content ids so
	// the targeted playlists' tracks are pulled too. Absent (the common
	// case) → whole-library incremental. The caller passes empty
	// watermarks alongside these so targeted rows re-read at current state.
	targetContentIds?: string[];
	targetPlaylistIds?: string[];
}

export interface ScanResult {
	watermarks: Record<string, number>;
	cancelled: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Write-side (sync TO rekordbox) — see writer.py / verifier.py / backup.py.
// One result per RPC; no streamed events because the work is bounded
// (one track or one playlist of tracks per sync).

export interface BackupResult {
	path: string;
	sizeBytes: number;
	takenAtMs: number;
}

export interface BackupSummary {
	path: string;
	sizeBytes: number;
	takenAtMs: number;
}

export interface ClearBackupsResult {
	deleted: number;
	freedBytes: number;
}

// rb's cue color palette, surfaced as opaque tokens to the high-level app.
// `id` is what Curator stores in cue.color (format: "cti:N"). `hex` is a
// renderable color; `label` is the picker label. Source of truth lives in
// apps/rekordbox/src/curator_rekordbox/palette.py — nothing above the
// sidecar layer should construct these by hand.
export interface CuePaletteEntry {
	id: string;
	hex: string;
	label: string;
}

// Wire shape for the write-batch payload. Mirrors the dispatch table in
// writer.py:apply_batch — every op carries a `kind` discriminator the
// Python side switches on. Field names are PascalCase where they map
// to DjmdContent columns (Title/ArtistName/AlbumName/LabelName) so the
// writer can pass them through without renaming.
export type WriteOp =
	| {
		kind: 'track';
		rb_content_id: string;
		// Only the fields present here are written; missing keys mean
		// "Curator has no opinion." Explicit null/"" means "clear".
		fields: Partial<{
			Title: string | null;
			ArtistName: string | null;
			AlbumName: string | null;
			LabelName: string | null;
			GenreName: string | null;
			Rating: number;
			// DjmdContent.Commnt (rb's column really is misspelled; the wire
			// key stays sane and writer.py maps it).
			Comment: string | null;
			// Curator colorLabel name ('red'|'orange'|...) — writer.py maps
			// it to DjmdContent.ColorID via the reverse of the reader's map.
			Color: string | null;
		}>;
	}
	| {
		kind: 'cues';
		rb_content_id: string;
		cues: Array<{
			slot: number;
			kind: 'hot' | 'memory';
			position_sec: number;
			length_sec: number | null;
			color: string | null;
			name: string | null;
		}>;
	}
	| {
		kind: 'tags';
		rb_content_id: string;
		rb_tag_ids: string[];
	}
	| {
		// Targeted membership merge — replaces the old wholesale wipe-and-re-add.
		// The Curator side computes a baseline-vs-current diff and pushes only
		// what changed, so rekordbox members Curator doesn't manage are never
		// touched. `remove`/`add` are keyed on rb_content_id; `order` is the
		// full desired order of Curator-known members (1-based by array index),
		// or null when an order conflict holds the reorder.
		kind: 'playlist_merge';
		rb_playlist_id: string;
		name?: string;
		remove: string[];                                       // rb_content_ids to remove
		add: Array<{ rb_content_id: string; position: number }>; // rb_content_ids to add (1-based target TrackNo)
		order: string[] | null;                                 // desired order of known members, or null = held
	}
	| {
		// Name-only push for a DjmdPlaylist row — used for FOLDERS, whose names
		// playlist_merge deliberately skips (it can't touch folder member lists,
		// so it bails before the name write). No member changes; idempotent —
		// the writer no-ops when the name already matches. Self-verifying via the
		// `name_changed` result, so the exporter keeps these out of the read-back
		// verify pass.
		kind: 'playlist_rename';
		rb_playlist_id: string;
		name: string;
	}
	| {
		// Remove a track from rekordbox's Collection. The writer soft-deletes
		// (rb_local_deleted = 1 on DjmdContent + its DjmdSongPlaylist rows) —
		// rekordbox's own tombstone convention, reversible, no FK cleanup.
		// Emitted by the exporter for every unpushed rekordbox_deleted_content
		// row, i.e. tracks the user deleted from Curator. Idempotent.
		kind: 'content_delete';
		rb_content_id: string;
	};

// Create ops — the only writes that mint rekordbox rows (Convert to WAV;
// see create-phase.ts). Kept out of the WriteOp union on purpose: every
// WriteOp targets an existing rb id, and the update pipeline (missing-row
// pruning, verify filtering, baseline advance) is written against that.
export type CreateOp =
	| {
		// Create (or find by FolderPath) the DjmdContent row for a local file.
		// With source_rb_content_id, the writer copies that row's ANLZ files
		// (beatgrid, waveforms, phrases) into the new row's analysis folder
		// with the audio path rewritten, plus its BPM/KeyID/artwork — the
		// copy is the same audio timeline, so rekordbox never re-analyses.
		kind: 'content_create';
		curator_track_id: string;
		path: string;
		source_rb_content_id: string | null;
		meta: {
			Title: string;
			ArtistName: string | null;
			AlbumName: string | null;
			LabelName: string | null;
			GenreName: string | null;
			Rating: number | null;
			Comment: string | null;
			Color: string | null;
			bpm: number | null;
			length_sec: number | null;
			sample_rate: number | null;
			bit_depth: number | null;
			channels: number | null;
			release_year: number | null;
			key_camelot: string | null;
		};
	}
	| {
		// New root-level DjmdPlaylist.
		kind: 'playlist_create';
		curator_playlist_id: string;
		name: string;
	};

// What verify reads back for a create op — built from the write results
// (the ids only exist after the writer ran).
export type CreatedVerifyOp =
	| { kind: 'content_create'; rb_content_id: string; path: string; anlz_copied: boolean }
	| { kind: 'playlist_create'; rb_playlist_id: string; name: string };

// Per-op result shape from writer.apply_batch.
export interface WriteOpResult {
	kind: WriteOp['kind'] | CreateOp['kind'];
	// content_create / playlist_create results.
	curator_track_id?: string;
	curator_playlist_id?: string;
	created?: boolean;
	revived?: boolean;
	anlz_copied?: boolean;
	anlz_files?: string[];
	artwork_copied?: boolean;
	folder_path?: string;
	// Present on success. False = field-equal to current rb state, no
	// SQLAlchemy write happened (no USN bump on commit).
	changed?: boolean;
	// `cues` / `tags` / `playlist` ops return counts instead of a single
	// changed bool. Each is the number of rows added/removed inside the
	// per-target wipe-and-re-add.
	inserted?: number;
	deleted?: number;
	tracks_written?: number;
	tracks_removed?: number;
	// playlist_merge counts.
	added?: number;
	removed?: number;
	reordered?: boolean;
	name_changed?: boolean;
	rb_content_id?: string;
	rb_playlist_id?: string;
	// True iff the target row was missing on the rb side (update-only
	// contract — exporter counts these as "skipped (not in rekordbox)").
	skipped?: boolean;
	// True iff the writer found NO matching row to update — the rb side
	// row was deleted between Curator's last read sync and this write.
	// Strict subset of `skipped`: every missing op is also skipped, but
	// not every skipped op is missing (smart-playlist guards also skip).
	// The exporter uses this to (a) drop the dead curator-side linkage
	// and (b) filter the op out of verify so the verifier doesn't
	// re-discover the same gap as a verification failure.
	missing?: boolean;
	error?: string;
	// playlist_merge only: rb_content_ids whose djmdContent row is gone
	// (track deleted in rekordbox since Curator's last read) — the writer
	// skipped those adds. The exporter prunes their curator-side links (same
	// evidence class as a missing track op) and filters them out of the op
	// before verify, or the verifier would flag "expected added, missing".
	missing_adds?: string[];
	// content_delete only: DjmdSongPlaylist rows soft-deleted alongside the
	// content row (ghost playlist entries for the deleted track).
	memberships_removed?: number;
}

// One write op the writer could not apply (its SAVEPOINT rolled back; the
// rest of the batch continued). Collected by the exporter with curator-side
// attribution so the failure toast can say WHICH track — the original
// lone-surrogate incident surfaced only as an opaque whole-sync rollback.
export interface WriteFailure {
	kind: WriteOp['kind'] | CreateOp['kind'];
	// rb_content_id | rb_playlist_id, whichever the op targeted.
	target: string;
	// Curator-side track title / playlist name, when the target could be
	// resolved back through rekordboxLink / playlist rows.
	targetLabel: string | null;
	error: string;
}

export interface CommitResult {
	// rb_content_id → post-commit djmdContent.updated_at as epoch ms.
	// null means the row vanished or carried no timestamp; exporter
	// treats null as "don't advance the baseline for this track."
	baselines: Record<string, number | null>;
}

export interface VerifyFailure {
	kind: WriteOp['kind'] | CreateOp['kind'];
	target: string | null;
	// Human-facing label for the target (e.g. a playlist's name). Null for
	// track-scoped ops; the UI falls back to `target`.
	target_label: string | null;
	error: string;
}

export interface VerifyResult {
	ok: boolean;
	pragma_error: string | null;
	failures: VerifyFailure[];
}

// The relation-backed text fields rekordbox stores as an FK (writer.py's
// lookup-or-create tables). Names match SyncFieldKey so the exporter's
// conflict shield reads them directly.
export type StaleRelationField = 'artist' | 'album' | 'label' | 'genre';

// One list_stale_relations entry: a live rb content row and what about it is
// bound to a tombstone — FK fields, and the names of tombstoned MyTags it is
// still a member of.
export interface StaleRelation {
	rbContentId: string;
	fields: StaleRelationField[];
	myTags: string[];
}

export interface ProgressEvent {
	phase: 'tracks' | 'cues' | 'playlists' | 'mytags' | 'waveforms' | 'history';
	done: number;
	total: number;
}

// 'playlist_index' is emitted once per COMPLETE playlists pass (never after a
// failed fetch or a cancel) and carries the live DjmdPlaylist ids — rekordbox
// hard-deletes rows no sync peer has seen, so absence from this index is the
// only signal the importer gets for those deletions (see PlaylistIndex in
// proto.py and prunePlaylistsMissingFromRekordbox in importer.ts).
export type SidecarEventKind = 'progress' | 'track' | 'cues' | 'playlist' | 'playlist_index' | 'mytag' | 'waveform' | 'history';

export interface SidecarError extends Error {
	kind: 'key' | 'db_missing' | 'db_locked' | 'internal' | 'sidecar_unavailable' | 'cancelled' | 'unsupported_rb_version';
}

function sidecarError(kind: SidecarError['kind'], message: string): SidecarError {
	const e = new Error(message) as SidecarError;
	e.kind = kind;
	return e;
}

interface Pending<T> {
	resolve: (r: T) => void;
	reject: (e: SidecarError) => void;
	method: string;
	// Cleared on resolve/reject. When a request times out we both reject the
	// promise AND drop the pending entry so a late response from the sidecar
	// doesn't get dispatched to a long-dead caller.
	timer: NodeJS.Timeout | null;
	// Original timeout — re-armed from scratch when a heartbeat frame lands,
	// so a slow-but-alive RPC (commit_and_close on a big library) isn't
	// misreported as hung.
	timeoutMs: number;
	// Per-request progress sink (apply_write_batch / commit_and_close). When
	// set, this request's `progress` frames go here instead of the shared
	// 'event' stream — that stream belongs to the importer's scan, and a
	// write's progress must never be mistaken for reader deltas.
	onProgress?: (done: number, total: number) => void;
}

// Progress frame from a write-side RPC: {id, event:'progress', done, total}.
export type WriteProgress = (done: number, total: number) => void;

// Per-method timeout. Numbers picked so a healthy run never trips them but
// a true hang (pyrekordbox internal deadlock, slow IO) can't strand the
// progress modal forever. The exporter's catch surfaces the timeout as a
// 'failed' event, which closes the modal and toasts the error. Read-side
// methods get the default 30s; write/verify get 5min because SQLCipher
// reopens + masterPlaylists6.xml flushes on big libraries can be slow.
const RPC_TIMEOUT_MS: Record<string, number> = {
	open_for_write: 60_000,
	apply_write_batch: 120_000,
	commit_and_close: 300_000,
	verify: 300_000,
	backup: 60_000,
	restore_backup: 60_000,
};
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

const RESPAWN_DELAYS_MS = [500, 1000, 2000, 5000, 10000, 30000];
const MAX_RESPAWN_BURST = 6;

// Hello handshake — mirrors the analyzer host. The sidecar's first stdout
// frame announces {event:'hello', name, version, protocol}; a wrong name or
// protocol means we're talking to the wrong executable or a stale bundle,
// which is fatal (this sidecar WRITES into Pioneer's master.db — silently
// mismatched code is the worst failure mode available). No hello at all is
// a warning, not fatal, so an old-but-compatible bundle keeps working.
const EXPECTED_SIDECAR_NAME = 'curator-rekordbox';
const EXPECTED_PROTOCOL = 1;
const HELLO_TIMEOUT_MS = 15_000;

export class RekordboxSidecar extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private pending = new Map<number, Pending<any>>();
	private stdoutBuffer = '';
	private stderrBuf = '';
	private respawnAttempts = 0;
	private respawnBurstAt = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;
	// Set on handshake mismatch — scheduleRespawn then refuses to restart.
	private permanentlyBroken = false;
	private helloSeen = false;
	private helloTimer: NodeJS.Timeout | null = null;

	constructor(private readonly opts: SidecarOptions) { super(); }

	start(): void {
		if (this.proc) return;
		this.shuttingDown = false;
		const proc = spawn(this.opts.executable, this.opts.args ?? [], {
			cwd: this.opts.cwd,
			env: {
				...process.env,
				...this.opts.env,
				PYTHONUNBUFFERED: '1',
				// Windows' default stdout codec is cp1252 — a non-ASCII track
				// title (Polish "ś", Japanese, emoji, …) makes print() raise
				// UnicodeEncodeError mid-scan and kills the sidecar. Force
				// UTF-8 on both stdio streams to match what Node reads.
				PYTHONIOENCODING: 'utf-8',
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc = proc;
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk: string) => {
			// Python tracebacks and the writer's per-op failure notes come
			// through here — route into the session log, line-buffered so a
			// traceback split across chunks doesn't produce broken records.
			this.stderrBuf += chunk;
			let idx = this.stderrBuf.indexOf('\n');
			while (idx >= 0) {
				const line = this.stderrBuf.slice(0, idx);
				this.stderrBuf = this.stderrBuf.slice(idx + 1);
				if (line.length > 0) log.for('rekordbox').info(line);
				idx = this.stderrBuf.indexOf('\n');
			}
		});
		proc.on('exit', (code, signal) => this.onExit(code, signal));
		proc.on('error', (err) => rlog.error('spawn error', err));

		this.helloSeen = false;
		if (this.helloTimer) clearTimeout(this.helloTimer);
		this.helloTimer = setTimeout(() => {
			this.helloTimer = null;
			if (!this.helloSeen && this.proc) {
				rlog.warn(
					'no hello frame — sidecar predates the handshake (stale binary?). Proceeding, but version compatibility is unverified.',
					{ timeoutMs: HELLO_TIMEOUT_MS },
				);
			}
		}, HELLO_TIMEOUT_MS);

		this.emit('ready');
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let nl: number;
		while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: unknown;
			try { frame = JSON.parse(line); }
			catch (err) {
				rlog.error('bad frame', err, { line });
				continue;
			}
			this.dispatchFrame(frame as Record<string, unknown>);
		}
	}

	private dispatchFrame(frame: Record<string, unknown>): void {
		const id = frame['id'] as number | null | undefined;
		const event = frame['event'] as SidecarEventKind | 'hello' | 'heartbeat' | undefined;

		if (event === 'hello') {
			this.helloSeen = true;
			if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
			const name = frame['name'];
			const protocol = frame['protocol'];
			if (name !== EXPECTED_SIDECAR_NAME || protocol !== EXPECTED_PROTOCOL) {
				this.permanentlyBroken = true;
				rlog.error(
					'sidecar handshake mismatch — sidecar disabled; rebuild or repoint it',
					undefined,
					{ gotName: String(name), gotProtocol: String(protocol), expectedName: EXPECTED_SIDECAR_NAME, expectedProtocol: EXPECTED_PROTOCOL },
				);
				try { this.proc?.kill(); } catch { /* already gone */ }
				return;
			}
			rlog.info('sidecar hello', { version: String(frame['version']), protocol: String(protocol) });
			return;
		}

		if (event === 'heartbeat' && typeof id === 'number') {
			// Liveness signal from a long-running RPC (commit_and_close emits
			// one every 10s while SQLCipher flushes). Re-arm the timeout so
			// "slow" isn't reported as "hung"; a genuinely dead sidecar stops
			// heartbeating and the timeout still fires. Not forwarded to
			// 'event' subscribers — it's transport-level, not import data.
			const pending = this.pending.get(id);
			if (pending && pending.timer) {
				clearTimeout(pending.timer);
				pending.timer = this.armTimeout(id, pending);
			}
			return;
		}

		if (event && typeof id === 'number') {
			// A flowing delta/progress stream proves the RPC is alive just as
			// well as a heartbeat does — re-arm its timeout so a long scan
			// can't be misreported as hung while it's actively emitting.
			const pending = this.pending.get(id);
			if (pending && pending.timer) {
				clearTimeout(pending.timer);
				pending.timer = this.armTimeout(id, pending);
			}
			if (pending?.onProgress) {
				if (event === 'progress') {
					const done = Number(frame['done']);
					const total = Number(frame['total']);
					if (Number.isFinite(done) && Number.isFinite(total)) {
						// A throwing UI sink must not take the RPC down with it.
						try { pending.onProgress(done, total); }
						catch (err) { rlog.warn('write progress sink threw', undefined, err); }
					}
				}
				return;
			}
			// Stream events flow to anyone subscribed; correlation by id is
			// optional since only one scan is in flight at a time, but we
			// pass it through so multi-scan futures are easy.
			this.emit('event', { id, event, frame });
			return;
		}

		if (typeof id === 'number' && (frame['result'] !== undefined || frame['error'] !== undefined)) {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			if (frame['error']) {
				const err = frame['error'] as { kind?: string; message?: string };
				pending.reject(sidecarError(
					(err.kind as SidecarError['kind']) ?? 'internal',
					err.message ?? 'rekordbox sidecar error',
				));
			} else {
				pending.resolve(frame['result']);
			}
			return;
		}

		rlog.warn('unhandled frame', { frame });
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		rlog.warn('sidecar exited', { code, signal, pending: this.pending.size });
		this.proc = null;
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(sidecarError('sidecar_unavailable', `sidecar exited (code=${code})`));
		}
		this.pending.clear();
		this.stdoutBuffer = '';
		if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
		if (this.shuttingDown) return;
		this.scheduleRespawn();
	}

	private scheduleRespawn(): void {
		if (this.permanentlyBroken) {
			this.emit('disabled');
			return;
		}
		const now = Date.now();
		if (now - this.respawnBurstAt > 60_000) {
			this.respawnBurstAt = now;
			this.respawnAttempts = 0;
		}
		if (this.respawnAttempts >= MAX_RESPAWN_BURST) {
			rlog.error('respawn limit reached — sidecar disabled');
			this.emit('disabled');
			return;
		}
		const delay = RESPAWN_DELAYS_MS[Math.min(this.respawnAttempts, RESPAWN_DELAYS_MS.length - 1)]!;
		this.respawnAttempts++;
		this.respawnTimer = setTimeout(() => {
			this.respawnTimer = null;
			rlog.info('respawning sidecar', { attempt: this.respawnAttempts });
			this.start();
		}, delay);
	}

	// Arm (or re-arm) the per-RPC timeout. On fire: drop the entry so a late
	// response from the sidecar doesn't dispatch into a resolved promise,
	// then surface the timeout so the exporter can emit 'failed' and the
	// modal can recover.
	private armTimeout<T>(id: number, entry: Pending<T>): NodeJS.Timeout {
		return setTimeout(() => {
			const current = this.pending.get(id);
			if (!current) return;
			this.pending.delete(id);
			rlog.warn('sidecar rpc timed out', { method: entry.method, timeoutMs: entry.timeoutMs });
			entry.reject(sidecarError('internal', `${entry.method} timed out after ${Math.round(entry.timeoutMs / 1000)}s`));
		}, entry.timeoutMs);
	}

	private sendRequest<T>(method: string, params?: Record<string, unknown>, onProgress?: WriteProgress): Promise<T> {
		if (!this.proc || !this.proc.stdin.writable) {
			return Promise.reject(sidecarError('sidecar_unavailable', 'rekordbox sidecar not running'));
		}
		const id = this.nextId++;
		const timeoutMs = RPC_TIMEOUT_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
		return new Promise<T>((resolve, reject) => {
			const entry: Pending<T> = { resolve, reject, method, timer: null, timeoutMs, onProgress };
			entry.timer = this.armTimeout(id, entry);
			this.pending.set(id, entry);
			// Scrub lone UTF-16 surrogates before serialization — this is the
			// single choke point every rb RPC flows through. JSON.stringify
			// legally escapes a lone surrogate (\udc90), Python's json.loads
			// faithfully reconstructs it, and SQLAlchemy's strict UTF-8 encode
			// at flush throws "surrogates not allowed" — which used to roll
			// back an ENTIRE sync batch. Copy-on-write: all-clean params (the
			// overwhelmingly common case) pass through untouched.
			const payload = JSON.stringify(params ? { id, method, params: scrubLoneSurrogates(params) } : { id, method });
			try { this.proc!.stdin.write(payload + '\n'); }
			catch (err) {
				if (entry.timer) clearTimeout(entry.timer);
				this.pending.delete(id);
				reject(sidecarError('sidecar_unavailable', err instanceof Error ? err.message : String(err)));
			}
		});
	}

	open(params: OpenParams): Promise<{ ok: boolean; path: string }> {
		return this.sendRequest('open', params as unknown as Record<string, unknown>);
	}

	detect(): Promise<DetectResult> {
		return this.sendRequest('detect');
	}

	scan(params: ScanParams): Promise<ScanResult> {
		return this.sendRequest('scan', params as unknown as Record<string, unknown>);
	}

	cancel(): Promise<void> {
		// Best-effort — fire-and-forget. The in-flight scan future will
		// resolve with cancelled=true once the worker thread notices.
		if (!this.proc || !this.proc.stdin.writable) return Promise.resolve();
		try {
			this.proc.stdin.write(JSON.stringify({ method: 'cancel' }) + '\n');
		} catch { /* ignore */ }
		return Promise.resolve();
	}

	// ──────────────────────────────────────────────────────────────────
	// Write-side RPCs. These all reject with `db_locked` (or another
	// SidecarError kind) when the Python side raises; the exporter
	// catches and surfaces to the user. Each returns one result;
	// apply_write_batch (and commit_and_close, should it ever report one)
	// stream `progress` frames to the optional per-call sink, and every
	// progress/heartbeat frame re-arms the RPC timeout.

	backup(dbPath: string): Promise<BackupResult> {
		return this.sendRequest('backup', { dbPath });
	}

	openForWrite(params: OpenParams): Promise<{ ok: boolean; path: string }> {
		return this.sendRequest('open_for_write', params as unknown as Record<string, unknown>);
	}

	applyWriteBatch(ops: ReadonlyArray<WriteOp | CreateOp>, onProgress?: WriteProgress): Promise<{ results: WriteOpResult[] }> {
		return this.sendRequest('apply_write_batch', { ops }, onProgress);
	}

	commitAndClose(writtenRbContentIds: string[], onProgress?: WriteProgress): Promise<CommitResult> {
		return this.sendRequest('commit_and_close', { writtenRbContentIds }, onProgress);
	}

	verify(
		dbPath: string,
		key: string | undefined,
		expectedWrites: ReadonlyArray<WriteOp | CreatedVerifyOp>,
	): Promise<VerifyResult> {
		return this.sendRequest('verify', { dbPath, key, expectedWrites });
	}

	listBackups(dbDir: string): Promise<{ backups: BackupSummary[] }> {
		return this.sendRequest('list_backups', { dbDir });
	}

	clearBackups(dbDir: string): Promise<ClearBackupsResult> {
		return this.sendRequest('clear_backups', { dbDir });
	}

	restoreBackup(backupPath: string, dbPath: string): Promise<{ ok: boolean }> {
		return this.sendRequest('restore_backup', { backupPath, dbPath });
	}

	listCuePalette(): Promise<{ entries: CuePaletteEntry[] }> {
		return this.sendRequest('list_cue_palette', {});
	}

	// Read-only probe: live rb content rows whose Artist/Album/Label/Genre FK
	// points at a relation row rekordbox has tombstoned (renders blank), or
	// with a membership at a tombstoned MyTag — per row, WHICH relations are
	// dead, so the exporter's "Sync updates" sweep only pushes the ones the
	// writer can actually re-point (see sweepStaleRelations).
	listStaleRelations(dbPath: string, key: string | undefined): Promise<{ stale: StaleRelation[] }> {
		return this.sendRequest('list_stale_relations', { dbPath, key });
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
		if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
		if (!this.proc) return;
		try { this.proc.stdin.write(JSON.stringify({ method: 'shutdown' }) + '\n'); }
		catch { /* ignore */ }
		const proc = this.proc;
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				try { proc.kill('SIGKILL'); } catch { /* */ }
				resolve();
			}, 2000);
			proc.once('exit', () => { clearTimeout(t); resolve(); });
		});
		this.proc = null;
	}
}
