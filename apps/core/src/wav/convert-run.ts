// "Convert to WAV" — playlist-level run.
//
// For every FLAC member: the audio sidecar binary decodes it to a plain-PCM
// WAV at `<outputDir>/<stem>.wav.part` (bit-exact up to 48 kHz/24-bit, see
// audio-header.ts planWavOutput), materialize.ts mints the WAV copy's track
// row bound to the FINAL path, then the .part is renamed into place. Members
// that already play on older decks (WAV/AIFF/MP3/AAC, or an existing copy)
// are kept as-is; members with no local file are skipped. The result is a
// "<name> [WAV]" playlist mirroring the source order, found again on re-runs
// through playlist.derived_from_playlist_id (re-runs reuse existing copies).
//
// Pushing the playlist + copies into rekordbox is a separate, explicit step
// (Sync to Rekordbox… on the [WAV] playlist — see rekordbox/create-phase.ts).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { cpus } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { asc, eq, inArray } from 'drizzle-orm';
import { playlist, playlistTrack, track, rekordboxLink, sourceLink, type NewPlaylist, type NewPlaylistTrack, type TrackArtist, type TrackOverrides } from '@curator/shared/schema';
import { searchFold, withFormatTag, type ArtistCreditFormat } from '@curator/shared';
import type { Db } from '../db/client.js';
import { audioHash } from '../ingest/audio-hash.js';
import { normalizePath } from '../local/scanner.js';
import { effectiveAlbum, effectiveArtistName, effectiveGenre, effectiveLabel, effectiveTitle } from '../sync/curator-view.js';
import { log } from '../log.js';
import { WAV_MAX_SAMPLE_RATE, estimateWavBytes, planWavOutput, readFlacFormat, type AudioFormat } from './audio-header.js';
import { runWavJob, WavJobError, type WavConverterSpec, type WavJobTags } from './converter.js';
import { discardWavCopy, findLiveDerivative, localLinksFor, materializeWavCopy, rebindWavCopy } from './materialize.js';
import type { WavConvertEvent, WavConvertResult, WavMemberPlan, WavPreview } from './types.js';
import { replaceRows } from '../library/playlist-order.js';

const wlog = log.for('wav-convert');

// Already playable on CDJ-2000/900-era decks — goes into the [WAV] playlist
// unchanged. (M4A can be ALAC, which those decks can't play; we can't tell
// without parsing the MP4 sample description, so it's kept as-is.)
const DECK_PLAYABLE_EXTS = new Set(['.wav', '.aif', '.aiff', '.mp3', '.m4a', '.mp4', '.aac']);

export interface WavConvertDeps {
	db: Db;
	sqlite: Database.Database;
	spec: WavConverterSpec | null;
	peaksDir?: string;
	outputDir(): string;
	// Make sure the output folder is watched (a library folder or under one),
	// so deleting a WAV on disk orphans its link like any other local file.
	ensureWatched(dir: string): Promise<void>;
	recomputeMembership(trackId: string): void;
	// Queue a peaks-only analysis for copies whose original had no .cpk.
	// Rejects when the analyzer is disabled — the run treats that as "no
	// waveform until the user analyzes", not as a failure.
	requestPeaks(trackIds: string[]): Promise<void>;
	creditFormat(): ArtistCreditFormat;
}

interface TrackRow {
	id: string;
	title: string;
	artists: TrackArtist[];
	overrides: TrackOverrides | null;
	albumTitle: string | null;
	genre: string | null;
	label: string | null;
	bpm: number | null;
	keyCamelot: string | null;
	releaseDate: string | null;
	comment: string | null;
	duration: number | null;
	derivedFromTrackId: string | null;
	deletedAt: Date | null;
}

interface PlanItem {
	trackId: string;
	title: string;
	plan: WavMemberPlan;
	// convert: the FLAC to read + its header (null if STREAMINFO unreadable).
	sourcePath?: string;
	format?: AudioFormat | null;
	// reuse, or convert-into-existing-copy (its old file went missing).
	copyId?: string;
}

interface Plan {
	playlistId: string;
	playlistName: string;
	memberIds: string[];          // source order, duplicates preserved
	items: Map<string, PlanItem>;
	rows: Map<string, TrackRow>;
}

async function freeBytesAt(dir: string): Promise<number | null> {
	// statfs needs an existing path — walk up to the nearest existing ancestor
	// (the output folder is created lazily on the first run).
	let p = dir;
	for (let i = 0; i < 32; i++) {
		if (existsSync(p)) {
			try {
				const s = await statfs(p);
				return Number(s.bavail) * Number(s.bsize);
			} catch {
				return null;
			}
		}
		const up = dirname(p);
		if (up === p) break;
		p = up;
	}
	return null;
}

function isFlacLink(l: { filePath: string; fileFormat: string | null }): boolean {
	return l.fileFormat === 'flac' || l.filePath.toLowerCase().endsWith('.flac');
}

export async function planPlaylistConversion(deps: WavConvertDeps, playlistId: string): Promise<Plan> {
	const { db } = deps;
	const pl = db.select().from(playlist).where(eq(playlist.id, playlistId)).get();
	if (!pl) throw new Error(`Playlist ${playlistId} not found`);
	if (pl.isSmart) throw new Error('Smart playlists have no stored track list to convert');
	const memberIds = db
		.select({ trackId: playlistTrack.trackId })
		.from(playlistTrack)
		.where(eq(playlistTrack.playlistId, playlistId))
		.orderBy(asc(playlistTrack.position))
		.all()
		.map((r) => r.trackId);
	const unique = Array.from(new Set(memberIds));
	const rows = new Map<string, TrackRow>();
	for (let i = 0; i < unique.length; i += 500) {
		for (const r of db
			.select({
				id: track.id, title: track.title, artists: track.artists, overrides: track.overrides,
				albumTitle: track.albumTitle, genre: track.genre, label: track.label, bpm: track.bpm,
				keyCamelot: track.keyCamelot, releaseDate: track.releaseDate, comment: track.comment,
				duration: track.duration, derivedFromTrackId: track.derivedFromTrackId, deletedAt: track.deletedAt,
			})
			.from(track)
			.where(inArray(track.id, unique.slice(i, i + 500)))
			.all()) rows.set(r.id, r);
	}
	const links = localLinksFor(db, unique);
	const items = new Map<string, PlanItem>();
	for (const id of unique) {
		const t = rows.get(id);
		const title = t ? effectiveTitle(t, deps.creditFormat()) : id;
		const mine = (links.get(id) ?? []).filter((l) => existsSync(l.filePath));
		if (!t || t.deletedAt) { items.set(id, { trackId: id, title, plan: 'skipped' }); continue; }
		if (t.derivedFromTrackId) {
			items.set(id, { trackId: id, title, plan: mine.length > 0 ? 'kept' : 'skipped' });
			continue;
		}
		const copy = findLiveDerivative(db, id);
		if (copy?.filePath && existsSync(copy.filePath)) {
			items.set(id, { trackId: id, title, plan: 'reuse', copyId: copy.id });
			continue;
		}
		const flac = mine.find(isFlacLink);
		if (flac) {
			const format = await readFlacFormat(flac.filePath).catch(() => null);
			items.set(id, { trackId: id, title, plan: 'convert', sourcePath: flac.filePath, format, copyId: copy?.id });
			continue;
		}
		const playable = mine.find((l) => DECK_PLAYABLE_EXTS.has(extname(l.filePath).toLowerCase()));
		items.set(id, { trackId: id, title, plan: playable ? 'kept' : 'skipped' });
	}
	return { playlistId, playlistName: pl.name, memberIds, items, rows };
}

function findDerivedPlaylist(db: Db, sourcePlaylistId: string): { id: string; name: string; source: string } | null {
	return db
		.select({ id: playlist.id, name: playlist.name, source: playlist.source })
		.from(playlist)
		.where(eq(playlist.derivedFromPlaylistId, sourcePlaylistId))
		.orderBy(asc(playlist.createdAt))
		.get() ?? null;
}

export async function previewPlaylistConversion(deps: WavConvertDeps, playlistId: string): Promise<WavPreview> {
	const plan = await planPlaylistConversion(deps, playlistId);
	const outputDir = deps.outputDir();
	const derived = findDerivedPlaylist(deps.db, playlistId);
	const counts = { convert: 0, reuse: 0, kept: 0, skipped: 0, resample: 0 };
	let estimatedBytes = 0;
	const skippedTitles: string[] = [];
	for (const item of plan.items.values()) {
		counts[item.plan]++;
		if (item.plan === 'skipped' && skippedTitles.length < 8) skippedTitles.push(item.title);
		if (item.plan !== 'convert') continue;
		const duration = plan.rows.get(item.trackId)?.duration ?? null;
		// Unreadable STREAMINFO → assume CD format for the estimate only.
		const fmt = item.format ?? { container: 'flac' as const, sampleRate: 44100, bitDepth: 16, channels: 2, frames: null };
		if (planWavOutput(fmt).resampled) counts.resample++;
		estimatedBytes += estimateWavBytes(fmt, duration);
	}
	return {
		playlistId,
		playlistName: plan.playlistName,
		targetPlaylistName: derived?.name ?? withFormatTag(plan.playlistName, 'WAV'),
		targetPlaylistExists: derived != null,
		outputDir,
		available: deps.spec != null,
		...counts,
		estimatedBytes,
		freeBytes: await freeBytesAt(outputDir),
		skippedTitles,
	};
}

function buildTags(t: TrackRow, fmt: ArtistCreditFormat): WavJobTags {
	const release = t.overrides?.releaseDate ?? t.releaseDate;
	return {
		// Curator's effective values (overrides applied), not the FLAC's own
		// tags — the copy should read the way the library shows it.
		title: withFormatTag(effectiveTitle(t, fmt), 'WAV'),
		artist: effectiveArtistName(t, fmt),
		album: effectiveAlbum(t),
		genre: effectiveGenre(t),
		label: effectiveLabel(t),
		bpm: t.overrides?.bpm ?? t.bpm,
		key: t.overrides?.keyCamelot ?? t.keyCamelot,
		year: release ? release.slice(0, 4) : null,
		comment: t.comment,
	};
}

// Peaks are keyed by track id; the copy has the same audio timeline, so the
// original's .cpk files are the copy's waveform. Curator's own analysis
// first, then the rekordbox-derived file (same fallback order as
// resolveTrackPeaksPath). Returns false when neither exists.
async function copyPeaks(deps: WavConvertDeps, fromId: string, toId: string): Promise<boolean> {
	if (!deps.peaksDir) return false;
	const rb = deps.db.select({ rbContentId: rekordboxLink.rbContentId }).from(rekordboxLink).where(eq(rekordboxLink.trackId, fromId)).get();
	let copied = false;
	for (const tier of ['lo', 'hi'] as const) {
		const candidates = [join(deps.peaksDir, tier, `${fromId}.cpk`)];
		if (rb) candidates.push(join(deps.peaksDir, tier, `rb_${rb.rbContentId}.cpk`));
		const from = candidates.find((p) => existsSync(p));
		if (!from) continue;
		await copyFile(from, join(deps.peaksDir, tier, `${toId}.cpk`));
		copied = true;
	}
	return copied;
}

// Create or refresh the "<name> [WAV]" playlist so its members mirror the
// source order. Untouched when the order already matches (no updatedAt churn,
// no spurious rekordbox membership diff on the next push).
function upsertDerivedPlaylist(deps: WavConvertDeps, sourceId: string, sourceName: string, ordered: string[]): string {
	const { db, sqlite } = deps;
	const now = new Date();
	const existing = findDerivedPlaylist(db, sourceId);
	const rowsFor = (pid: string): NewPlaylistTrack[] => replaceRows(ordered.map((tid) => ({
		playlistId: pid, trackId: tid, addedAt: now, sourceTrackId: tid,
	})));
	if (existing) {
		const current = db
			.select({ trackId: playlistTrack.trackId })
			.from(playlistTrack)
			.where(eq(playlistTrack.playlistId, existing.id))
			.orderBy(asc(playlistTrack.position))
			.all()
			.map((r) => r.trackId);
		if (current.length === ordered.length && current.every((id, i) => id === ordered[i])) return existing.id;
		sqlite.transaction(() => {
			db.delete(playlistTrack).where(eq(playlistTrack.playlistId, existing.id)).run();
			const rows = rowsFor(existing.id);
			for (let i = 0; i < rows.length; i += 100) db.insert(playlistTrack).values(rows.slice(i, i + 100)).run();
			db.update(playlist).set({ trackCount: ordered.length, updatedAt: now }).where(eq(playlist.id, existing.id)).run();
		})();
		return existing.id;
	}
	const id = randomUUID();
	const name = withFormatTag(sourceName, 'WAV');
	const row: NewPlaylist = {
		id,
		source: 'local',
		sourceId: id,
		name,
		nameAscii: searchFold(name),
		trackCount: ordered.length,
		syncStatus: 'synced',
		derivedFromPlaylistId: sourceId,
		createdAt: now,
		updatedAt: now,
	};
	sqlite.transaction(() => {
		db.insert(playlist).values(row).run();
		const rows = rowsFor(id);
		for (let i = 0; i < rows.length; i += 100) db.insert(playlistTrack).values(rows.slice(i, i + 100)).run();
	})();
	return id;
}

// Output naming: `<FLAC stem>.wav`, then ` (2)`, ` (3)`… — never onto an
// existing file or a path another track already holds (source_link.file_path
// is unique), nor onto a name another worker of this run picked.
function allocateOutputPath(deps: WavConvertDeps, outDir: string, stem: string, reserved: Set<string>): string {
	for (let n = 1; n < 1000; n++) {
		const candidate = join(outDir, n === 1 ? `${stem}.wav` : `${stem} (${n}).wav`);
		const norm = normalizePath(candidate);
		if (reserved.has(norm) || existsSync(candidate)) continue;
		const held = deps.db.select({ id: sourceLink.id }).from(sourceLink).where(eq(sourceLink.filePath, norm)).get();
		if (held) continue;
		reserved.add(norm);
		return candidate;
	}
	throw new Error(`no free output name for "${stem}"`);
}

export class WavConverter extends EventEmitter {
	private active: { runId: string; playlistId: string; abort: AbortController } | null = null;

	constructor(private readonly deps: WavConvertDeps) { super(); }

	isRunning(): boolean { return this.active != null; }

	preview(playlistId: string): Promise<WavPreview> {
		return previewPlaylistConversion(this.deps, playlistId);
	}

	// Kicks off a run in the background and returns its id; progress and the
	// result arrive as WavConvertEvents. One run at a time — the converter is
	// CPU- and disk-heavy, and two runs could race for the same output names.
	start(playlistId: string): { runId: string } {
		if (!this.deps.spec) throw new Error('The WAV converter is not available in this build (audio sidecar binary missing).');
		if (this.active) throw new Error('A WAV conversion is already running.');
		const runId = randomUUID();
		const abort = new AbortController();
		this.active = { runId, playlistId, abort };
		void this.run(runId, playlistId, abort.signal)
			.catch((err) => {
				wlog.error('conversion run failed', err, { playlistId });
				this.emitEvent({ kind: 'failed', runId, playlistId, message: err instanceof Error ? err.message : String(err) });
			})
			.finally(() => { this.active = null; });
		return { runId };
	}

	cancel(runId: string): void {
		if (this.active?.runId === runId) this.active.abort.abort();
	}

	cancelActive(): void {
		this.active?.abort.abort();
	}

	subscribe(cb: (e: WavConvertEvent) => void): () => void {
		const handler = (e: WavConvertEvent): void => { try { cb(e); } catch (err) { wlog.error('subscriber threw', err); } };
		this.on('event', handler);
		return () => { this.off('event', handler); };
	}

	private emitEvent(e: WavConvertEvent): void { this.emit('event', e); }

	private async run(runId: string, playlistId: string, signal: AbortSignal): Promise<void> {
		const deps = this.deps;
		const spec = deps.spec!;
		const plan = await planPlaylistConversion(deps, playlistId);
		const outDir = deps.outputDir();
		const todo = [...plan.items.values()].filter((i) => i.plan === 'convert');
		const total = todo.length;
		this.emitEvent({ kind: 'started', runId, playlistId, total });
		wlog.info('conversion started', { playlistId, convert: total, outputDir: outDir });

		if (total > 0) {
			await mkdir(outDir, { recursive: true });
			try { await deps.ensureWatched(outDir); }
			catch (err) { wlog.warn('could not watch the WAV output folder', { outDir }, err); }
		}

		const copyOf = new Map<string, string>();     // source track id → copy id
		for (const item of plan.items.values()) if (item.plan === 'reuse' && item.copyId) copyOf.set(item.trackId, item.copyId);
		const failures: WavConvertResult['failures'] = [];
		const needPeaks: string[] = [];
		const reserved = new Set<string>();
		const fractions = new Map<string, number>();
		let done = 0;
		let lastEmit = 0;
		let currentTitle: string | null = null;
		const emitProgress = (force: boolean): void => {
			const now = Date.now();
			if (!force && now - lastEmit < 250) return;
			lastEmit = now;
			// Fractional progress so a long single track still moves the bar.
			const partial = [...fractions.values()].reduce((a, b) => a + b, 0);
			this.emitEvent({ kind: 'progress', runId, playlistId, done: Math.min(total, done + partial), total, currentTitle });
		};

		const convertOne = async (item: PlanItem): Promise<void> => {
			const t = plan.rows.get(item.trackId)!;
			const stem = basename(item.sourcePath!, extname(item.sourcePath!));
			const finalPath = allocateOutputPath(deps, outDir, stem, reserved);
			const part = `${finalPath}.part`;
			currentTitle = item.title;
			fractions.set(item.trackId, 0);
			try {
				await rm(part, { force: true });
				await runWavJob(spec, {
					input: item.sourcePath!,
					output: part,
					maxSampleRate: WAV_MAX_SAMPLE_RATE,
					tags: buildTags(t, deps.creditFormat()),
					cover: true,
				}, {
					signal,
					onProgress: (f) => { fractions.set(item.trackId, f); emitProgress(false); },
				});
				const st = await stat(part);
				// Hashed from the .part file: rename preserves bytes, so the key is
				// the final file's. Equals the FLAC source's unless resampled.
				const input = { sourceTrackId: item.trackId, wavPath: normalizePath(finalPath), stat: { size: st.size, mtimeMs: st.mtimeMs }, audioHash: await audioHash(part) };
				// Bind BEFORE the rename — see materialize.ts.
				let copyId: string;
				if (item.copyId) {
					rebindWavCopy(deps.db, deps.sqlite, item.copyId, input);
					copyId = item.copyId;
				} else {
					copyId = materializeWavCopy(deps.db, deps.sqlite, input);
				}
				try {
					await rename(part, finalPath);
				} catch (err) {
					if (!item.copyId) discardWavCopy(deps.db, copyId);
					throw err;
				}
				copyOf.set(item.trackId, copyId);
				deps.recomputeMembership(copyId);
				if (!item.copyId && !(await copyPeaks(deps, item.trackId, copyId).catch(() => false))) needPeaks.push(copyId);
			} catch (err) {
				await rm(part, { force: true }).catch(() => {});
				if (err instanceof WavJobError && err.cancelled) return;
				const message = err instanceof Error ? err.message : String(err);
				wlog.warn('track conversion failed', { trackId: item.trackId, source: item.sourcePath, message });
				failures.push({ trackId: item.trackId, title: item.title, message });
				this.emitEvent({ kind: 'trackFailed', runId, playlistId, trackId: item.trackId, title: item.title, message });
			} finally {
				fractions.delete(item.trackId);
				done++;
				emitProgress(true);
			}
		};

		// Bounded pool: each job is one decode/encode process, CPU-bound for
		// FLAC decode and disk-bound for the write. Half the cores (max 4)
		// leaves the UI, playback and the analyzer room.
		const width = Math.min(4, Math.max(1, Math.floor(cpus().length / 2)));
		const queue = [...todo];
		await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
			for (let item = queue.shift(); item; item = queue.shift()) {
				if (signal.aborted) return;
				await convertOne(item);
			}
		}));

		if (needPeaks.length > 0) {
			deps.requestPeaks(needPeaks).catch((err) => wlog.info('peaks not queued for WAV copies', { count: needPeaks.length, reason: err instanceof Error ? err.message : String(err) }));
		}

		// Mirror the source order with whatever is playable now. A cancelled
		// run still builds the playlist from the copies it finished.
		const ordered: string[] = [];
		const counts = { converted: 0, reused: 0, kept: 0, skipped: 0 };
		for (const item of plan.items.values()) {
			if (item.plan === 'kept') counts.kept++;
			else if (item.plan === 'reuse') counts.reused++;
			else if (item.plan === 'skipped') counts.skipped++;
			else if (copyOf.has(item.trackId)) counts.converted++;
		}
		for (const id of plan.memberIds) {
			const item = plan.items.get(id);
			if (!item) continue;
			if (item.plan === 'kept') ordered.push(id);
			else if (copyOf.has(id)) ordered.push(copyOf.get(id)!);
		}
		const derivedId = ordered.length > 0 || findDerivedPlaylist(deps.db, playlistId)
			? upsertDerivedPlaylist(deps, playlistId, plan.playlistName, ordered)
			: '';
		const result: WavConvertResult = {
			playlistId: derivedId,
			...counts,
			failed: failures.length,
			cancelled: signal.aborted,
			outputDir: outDir,
			failures,
		};
		wlog.info('conversion finished', { playlistId, derivedId, ...counts, failed: failures.length, cancelled: signal.aborted });
		this.emitEvent({ kind: 'completed', runId, playlistId, result });
	}
}
