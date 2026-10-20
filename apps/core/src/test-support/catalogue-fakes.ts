// In-memory stand-ins for the shared analysis catalogue's server and blob
// store, modelling the rules apps/cloud/src/catalogue/catalogue.ts enforces
// (policy, blob path and existence, versions kept, quota, superseded paths,
// rev order), plus the fixtures the catalogue tests share: generated FLAC
// files (STREAMINFO MD5 + tags, no real audio) and a fake analyzer sidecar
// that writes fixed .cpk tiers. Never the network, never real files.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
	CATALOGUE_VERSIONS_KEPT,
	catalogueAllows,
	catalogueBlobPath,
	compareVersions,
	safeParseCatalogueItem,
	utf8ByteLength,
	type CatalogueInventoryInput,
	type CatalogueInventoryResult,
	type CatalogueItem,
	type CatalogueLookupInput,
	type CatalogueLookupResult,
	type CataloguePolicy,
	type CataloguePutInput,
	type CataloguePutResult,
	type CatalogueRejectReason,
	type StoredCatalogueItem,
} from '@curator/protocol';
import { encodePeaks } from '../analyzer/cpk.js';
import type { AnalyzeParams, AnalyzeResult } from '../analyzer/sidecar.js';
import { AnalysisQueue, EXPECTED_ANALYZER_VERSION, type AnalysisJobEvent } from '../analyzer/queue.js';
import type { AnalyzerSidecar } from '../analyzer/sidecar.js';
import { createCatalogueLayer, type CatalogueLayer, type CatalogueLayerDeps } from '../catalogue/layer.js';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { audioHash } from '../ingest/audio-hash.js';
import { CloudTransportError, type CloudSession } from '../sync-log/client.js';
import { CatalogueBlobError, type CatalogueBlobStore, type CatalogueTransport } from '../catalogue/types.js';

export const POLICY_D_A: CataloguePolicy = {
	allow: [
		{ unit: 'rhythm', variants: null },
		{ unit: 'key', variants: null },
		{ unit: 'structure', variants: null },
		{ unit: 'advanced', variants: null },
		{ unit: 'fingerprint', variants: null },
		{ unit: 'peaks', variants: ['lo'] },
	],
};
export const POLICY_D_B: CataloguePolicy = {
	allow: [...POLICY_D_A.allow.filter((a) => a.unit !== 'peaks'), { unit: 'peaks', variants: ['hi', 'lo'] }, { unit: 'vectors', variants: null }],
};

type Row = StoredCatalogueItem & { userId: string; dataBytes: number; blobBytes: number; blobPath: string | null };

export class FakeCatalogueServer {
	policy: CataloguePolicy = POLICY_D_A;
	entitled = true;
	quotaBytes = 943_718_400;
	// Every object in the bucket, keyed by path (the blob store writes here).
	readonly objects = new Map<string, Uint8Array>();
	private rows: Row[] = [];
	private rev = 0;
	readonly calls = { lookup: 0, put: 0, inventory: 0, lookupHashes: [] as string[][], putSizes: [] as number[] };
	// Fault injection: 'offline' rejects at once, 'hang' never answers.
	mode: 'ok' | 'offline' | 'hang' = 'ok';

	private async gate(): Promise<void> {
		if (this.mode === 'offline') throw new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED');
		if (this.mode === 'hang') await new Promise(() => { /* never */ });
	}

	items(userId: string): StoredCatalogueItem[] {
		return this.rows.filter((r) => r.userId === userId);
	}

	usedBytes(userId: string): number {
		return this.rows.filter((r) => r.userId === userId).reduce((n, r) => n + r.dataBytes + r.blobBytes, 0);
	}

	async lookup(userId: string, input: CatalogueLookupInput): Promise<CatalogueLookupResult> {
		this.calls.lookup++;
		this.calls.lookupHashes.push([...input.audioHashes]);
		await this.gate();
		const best = new Map<string, Row>();
		for (const r of this.rows) {
			if (r.userId !== userId || !input.audioHashes.includes(r.audioHash)) continue;
			const ok = input.want.some((w) => w.unit === r.unit
				&& (w.variant === undefined || w.variant === r.variant)
				&& (!w.minVersion || compareVersions(r.version, w.minVersion) >= 0)
				&& (w.maxSchema === undefined || r.unitSchema <= w.maxSchema));
			if (!ok) continue;
			const k = `${r.audioHash}|${r.unit}|${r.variant}`;
			const cur = best.get(k);
			if (!cur || compareVersions(r.version, cur.version) > 0) best.set(k, r);
		}
		return { items: [...best.values()].map(strip) };
	}

	async put(userId: string, input: CataloguePutInput): Promise<CataloguePutResult> {
		this.calls.put++;
		this.calls.putSizes.push(input.items.length);
		await this.gate();
		if (input.items.length > 100 || utf8ByteLength(JSON.stringify(input.items)) > 1024 * 1024) throw new CloudTransportError('bad_request', 'batch_too_large');
		if (!this.entitled) throw new CloudTransportError('bad_request', 'catalogue_not_entitled');
		const rejected: CataloguePutResult['rejected'] = [];
		const accepted: CataloguePutResult['accepted'] = [];
		const reject = (index: number, reason: CatalogueRejectReason) => rejected.push({ index, reason });
		const lastIndex = new Map<string, number>();
		input.items.forEach((raw, i) => {
			const it = raw as CatalogueItem;
			lastIndex.set(`${it.audioHash}|${it.unit}|${it.variant}|${it.version.join('.')}`, i);
		});
		const gone = new Set<string>();
		input.items.forEach((raw, index) => {
			const parsed = safeParseCatalogueItem(raw);
			if (!parsed.ok) return reject(index, 'invalid_item');
			const item = parsed.item;
			if (!catalogueAllows(this.policy, item.unit, item.variant)) return reject(index, 'unit_disabled');
			let blobPath: string | null = null;
			let blobBytes = 0;
			if (item.unit === 'peaks' || item.unit === 'vectors') {
				const b = item.data.blob;
				if (b.path !== catalogueBlobPath(userId, item.unit, b.sha256)) return reject(index, 'blob_path_invalid');
				const obj = this.objects.get(b.path);
				if (!obj) return reject(index, 'blob_missing');
				if (obj.byteLength !== b.bytes) return reject(index, 'blob_size_mismatch');
				blobPath = b.path;
				blobBytes = b.bytes;
			}
			if (lastIndex.get(`${item.audioHash}|${item.unit}|${item.variant}|${item.version.join('.')}`) !== index) return reject(index, 'duplicate_in_batch');
			const group = this.rows.filter((r) => r.userId === userId && r.audioHash === item.audioHash && r.unit === item.unit && r.variant === item.variant);
			const same = group.find((r) => compareVersions(r.version, item.version) === 0);
			if (!same && group.filter((r) => compareVersions(r.version, item.version) > 0).length >= CATALOGUE_VERSIONS_KEPT) return reject(index, 'version_outdated');
			const dataBytes = utf8ByteLength(JSON.stringify(item.data));
			const delta = dataBytes + blobBytes - (same ? same.dataBytes + same.blobBytes : 0);
			if (delta > 0 && this.usedBytes(userId) + delta > this.quotaBytes) return reject(index, 'quota_exceeded');
			const rev = ++this.rev;
			const row: Row = { ...(item as CatalogueItem), rev, deviceId: input.deviceId, updatedAt: Date.now(), userId, dataBytes, blobBytes, blobPath } as Row;
			if (same) {
				if (same.blobPath && same.blobPath !== blobPath) gone.add(same.blobPath);
				this.rows = this.rows.filter((r) => r !== same);
			}
			this.rows.push(row);
			accepted.push({ index, rev });
			// Retention: newest CATALOGUE_VERSIONS_KEPT per key.
			const all = this.rows.filter((r) => r.userId === userId && r.audioHash === item.audioHash && r.unit === item.unit && r.variant === item.variant)
				.sort((a, b) => compareVersions(b.version, a.version));
			for (const old of all.slice(CATALOGUE_VERSIONS_KEPT)) {
				this.rows = this.rows.filter((r) => r !== old);
				if (old.blobPath) gone.add(old.blobPath);
			}
		});
		const still = new Set(this.rows.filter((r) => r.userId === userId && r.blobPath).map((r) => r.blobPath!));
		const superseded = [...gone].filter((p) => !still.has(p)).sort();
		rejected.sort((a, b) => a.index - b.index);
		return { accepted, rejected, superseded, usage: { usedBytes: this.usedBytes(userId), quotaBytes: this.quotaBytes } };
	}

	async inventory(userId: string, input: CatalogueInventoryInput): Promise<CatalogueInventoryResult> {
		this.calls.inventory++;
		await this.gate();
		const limit = Math.min(input.limit ?? 5000, 5000);
		const rows = this.rows.filter((r) => r.userId === userId && r.rev > input.afterRev).sort((a, b) => a.rev - b.rev);
		const page = rows.slice(0, limit);
		return {
			entries: page.map((r) => ({ audioHash: r.audioHash, unit: r.unit, variant: r.variant, version: r.version, unitSchema: r.unitSchema, rev: r.rev, bytes: r.dataBytes + r.blobBytes, deviceId: r.deviceId })),
			nextRev: page.length > 0 ? page[page.length - 1]!.rev : input.afterRev,
			more: rows.length > limit,
			account: { entitled: this.entitled, quotaBytes: this.quotaBytes, usedBytes: this.usedBytes(userId) },
			policy: this.policy,
		};
	}
}

function strip(r: Row): StoredCatalogueItem {
	const { userId: _u, dataBytes: _d, blobBytes: _b, blobPath: _p, ...item } = r;
	return item as StoredCatalogueItem;
}

// A device's view: its session (mutable, for sign-out / account switch) and
// the server's procedures as that user.
export class FakeDevice {
	session: CloudSession | null;
	constructor(readonly server: FakeCatalogueServer, userId: string) {
		this.session = { userId, email: null };
	}
	private uid(): string {
		if (!this.session) throw new CloudTransportError('auth', 'signed out');
		return this.session.userId;
	}
	transport(): CatalogueTransport {
		return {
			session: () => this.session,
			catalogue: {
				lookup: async (i) => this.server.lookup(this.uid(), i),
				put: async (i) => this.server.put(this.uid(), i),
				inventory: async (i) => this.server.inventory(this.uid(), i),
			},
		};
	}
}

// Storage under the bucket policies: own prefix only, no update (an existing
// path is a 409 the store reports as success), inserts only when entitled.
export class FakeBlobStore implements CatalogueBlobStore {
	inFlight = 0;
	maxInFlight = 0;
	uploads = 0;
	downloads = 0;
	removed: string[] = [];
	constructor(private readonly server: FakeCatalogueServer, private readonly device: FakeDevice) {}
	private own(path: string): void {
		const uid = this.device.session?.userId.toLowerCase();
		if (!uid || !path.startsWith(`${uid}/`)) throw new CatalogueBlobError('denied', 'HTTP 403');
	}
	async upload(path: string, bytes: Uint8Array): Promise<void> {
		this.own(path);
		if (this.server.mode === 'offline') throw new CatalogueBlobError('transient', 'network');
		if (!this.server.entitled) throw new CatalogueBlobError('denied', 'HTTP 400 rls');
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			await new Promise((r) => setTimeout(r, 2));
			this.uploads++;
			if (!this.server.objects.has(path)) this.server.objects.set(path, new Uint8Array(bytes));
		} finally {
			this.inFlight--;
		}
	}
	async download(path: string): Promise<Uint8Array> {
		this.own(path);
		if (this.server.mode === 'offline') throw new CatalogueBlobError('transient', 'network');
		this.downloads++;
		const b = this.server.objects.get(path);
		if (!b) throw new CatalogueBlobError('not_found', 'HTTP 404');
		return new Uint8Array(b);
	}
	async remove(paths: string[]): Promise<void> {
		for (const p of paths) { this.own(p); this.server.objects.delete(p); this.removed.push(p); }
	}
}

// ── fixtures ────────────────────────────────────────────────────────────────

export const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// A FLAC the audio hasher reads exactly as a real one: 'fLaC', a STREAMINFO
// block carrying the PCM's MD5, then whatever tag bytes. Same PCM + other
// tags = same `pcm-md5:` key.
export function writeFlac(path: string, pcmMd5Hex: string, tags: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const info = Buffer.alloc(34);
	Buffer.from(pcmMd5Hex, 'hex').copy(info, 18);
	// STREAMINFO (not last), then a VORBIS_COMMENT-typed block of tag text.
	const tagBody = Buffer.from(tags, 'utf8');
	const tagHdr = Buffer.from([0x84, (tagBody.length >> 16) & 0xff, (tagBody.length >> 8) & 0xff, tagBody.length & 0xff]);
	writeFileSync(path, Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x00, 0, 0, 34]), info, tagHdr, tagBody, Buffer.alloc(256, 7)]));
}

const bands = (n: number, seed: number) => {
	const mk = (k: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + k * 13) & 0xff);
	return { low: mk(1), mid: mk(2), high: mk(3) };
};

// Fixed v3 (current writer) tiers: 20 Hz lo, 100 Hz hi, for a 30 s track.
export function fixedCpk(tier: 'lo' | 'hi', seed = 1): Buffer {
	const sps = tier === 'lo' ? 20 : 100;
	const n = sps * 30;
	return encodePeaks(sps, bands(n, seed), bands(Math.ceil(n / 10), seed + 1), { detailRms: bands(n, seed + 2), overviewRms: bands(Math.ceil(n / 10), seed + 3) });
}

const f32 = (n: number, step: number, off = 0) => Array.from({ length: n }, (_, i) => Math.fround(off + i * step));

// The analyzer result every fake pass "computes" for a file: deterministic,
// with values in every unit so the round trip has something to compare.
export function fullResult(p: AnalyzeParams, opts: { advanced?: boolean } = {}): AnalyzeResult {
	const o = p.options ?? {};
	const rhythm = !o.skipBeatgrid && o.priorBeatgrid === undefined;
	const key = !o.skipKey && o.priorKey === undefined;
	const structure = !o.skipSegments && !o.skipBeatgrid;
	const advanced = opts.advanced || (o.features?.length ?? 0) > 0;
	return {
		track_id: p.trackId,
		duration: 30.25,
		bpm: rhythm ? 124.5 : (o.priorBpm ?? null),
		beatgrid: rhythm ? f32(60, 0.4819, 0.12) : [...(o.priorBeatgrid ?? [])],
		downbeats: rhythm ? f32(15, 1.9277, 0.12) : [...(o.priorDownbeats ?? [])],
		key_camelot: key ? '8A' : (o.priorKey ?? null),
		key_strength: key ? 0.71 : (o.priorKeyStrength ?? null),
		brightness: advanced ? 0.42 : null,
		power: advanced ? 0.66 : null,
		dynamic_complexity: advanced ? 3.1 : null,
		loudness_range_lu: advanced ? 6.5 : null,
		dissonance: advanced ? 0.31 : null,
		density: advanced ? 12.5 : null,
		segments: structure ? [
			{ startSec: 0, endSec: 8, label: 'intro', confidence: 0.9, energy: 0.3 },
			{ startSec: 8, endSec: 22, label: 'drop', confidence: 0.8, energy: 0.9 },
			{ startSec: 22, endSec: 30.25, label: 'outro', confidence: 0.7, energy: 0.2 },
		] : [],
		intro_length_sec: structure ? 8 : null,
		outro_length_sec: structure ? 8.25 : null,
		first_drop_sec: structure ? 8 : null,
		drop_count: structure ? 1 : null,
		breakdown_count: structure ? 0 : null,
		// URL-safe, unpadded: what Chromaprint actually emits.
		fingerprint: o.skipFingerprint ? null : 'AQADtEmS-JEuSJ_mRHMnxHMlxJEdyJEdyJEeSJEmSJEmSJEmSJEmSJEmSw',
		fingerprint_duration_sec: o.skipFingerprint ? null : 30,
		features: advanced ? { lowlevel: { spectral_centroid: { mean: 1234.5 } }, rhythm: { danceability: 1.2 } } : {},
		peaks_lo_path: p.outPeaksLoPath,
		peaks_hi_path: p.outPeaksHiPath,
		analyzer_version: EXPECTED_ANALYZER_VERSION,
	};
}

// The analyzer stand-in: records every call, writes the fixed tiers unless
// the pass skips peaks, answers with fullResult.
export class FakeAnalyzer extends EventEmitter {
	calls: AnalyzeParams[] = [];
	// `perTrackPeaks`: tiers differ per track (distinct blobs); otherwise
	// every track gets the same fixed bytes (one content-addressed object).
	constructor(private readonly opts: { advanced?: boolean; perTrackPeaks?: boolean } = {}) { super(); }
	async analyze(p: AnalyzeParams): Promise<AnalyzeResult> {
		this.calls.push(p);
		if (!p.options?.skipPeaks) {
			const tier = (t: 'lo' | 'hi'): Buffer => {
				const buf = fixedCpk(t);
				// First body bytes from the track id: distinct, still a valid file.
				if (this.opts.perTrackPeaks) createHash('md5').update(p.trackId).digest().copy(buf, 21, 0, 8);
				return buf;
			};
			mkdirSync(dirname(p.outPeaksLoPath), { recursive: true });
			mkdirSync(dirname(p.outPeaksHiPath), { recursive: true });
			writeFileSync(p.outPeaksLoPath, tier('lo'));
			writeFileSync(p.outPeaksHiPath, tier('hi'));
		}
		return fullResult(p, this.opts);
	}
	cancel(): void { /* nothing in flight */ }
}

// ── a whole device ──────────────────────────────────────────────────────────


export type TestDevice = {
	dir: string;
	db: Db;
	sqlite: Database.Database;
	peaksDir: string;
	analyzer: FakeAnalyzer;
	queue: AnalysisQueue;
	device: FakeDevice;
	blobs: FakeBlobStore;
	layer: CatalogueLayer;
	features: { list: string[] | null };
	events: AnalysisJobEvent[];
	close(): void;
};

export function makeTestDevice(
	dir: string,
	server: FakeCatalogueServer,
	userId: string,
	opts: { analyzer?: FakeAnalyzer; layer?: Partial<CatalogueLayerDeps> } = {},
): TestDevice {
	mkdirSync(dir, { recursive: true });
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	const { db, sqlite } = createDb(dbPath);
	const peaksDir = join(dir, 'peaks');
	const analyzer = opts.analyzer ?? new FakeAnalyzer();
	const queue = new AnalysisQueue(db, analyzer as unknown as AnalyzerSidecar, { peaksDir, concurrency: 4 });
	const events: AnalysisJobEvent[] = [];
	queue.on('event', (e: AnalysisJobEvent) => events.push(e));
	const device = new FakeDevice(server, userId);
	const blobs = new FakeBlobStore(server, device);
	const features = { list: ['pull_skip_own', 'catalogue'] as string[] | null };
	const layer: CatalogueLayer = createCatalogueLayer({
		db,
		raw: sqlite,
		transport: device.transport(),
		blobs,
		deviceId: () => `dev-${userId.slice(0, 4)}-${dir.length}`,
		peaksDir,
		serverFeatures: () => features.list as never,
		onHydrated: (ids) => { queue.settleSatisfied(ids, (id, o) => layer.remaining(id, o)); },
		...opts.layer,
	});
	queue.setCatalogue(layer.queueHook);
	return {
		dir, db, sqlite, peaksDir, analyzer, queue, device, blobs, layer, features, events,
		close() { layer.stop(); sqlite.close(); },
	};
}

// A track with one local file at `path` (hash read off the file the way the
// scanner does) — the rows the scanner would have written, without chokidar.
export async function addLocalTrack(d: TestDevice, trackId: string, path: string, durationSec = 30): Promise<string> {
	const hash = await audioHash(path);
	if (!hash) throw new Error('fixture FLAC did not hash');
	d.sqlite.prepare(`INSERT INTO track (id, title, artists, state, duration) VALUES (?, ?, '[{"name":"Artist"}]', 'unsorted', ?)`).run(trackId, `Title ${trackId}`, durationSec);
	d.sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash, duration_local) VALUES (?, ?, 'local', ?, ?, ?, ?)`)
		.run(`sl-${trackId}`, trackId, path, path, hash, durationSec);
	return hash;
}

export async function waitFor(cond: () => boolean, label: string, ms = 5000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

export function jobState(d: TestDevice, trackId: string): string | undefined {
	return (d.sqlite.prepare(`SELECT state FROM analysis_job WHERE track_id = ?`).get(trackId) as { state: string } | undefined)?.state;
}

// A distinct, non-zero PCM MD5 per index.
export const pcmMd5 = (i: number): string => (i + 1).toString(16).padStart(8, '0').repeat(4);

// Generated files on device `d`, analysed there by its fake analyzer (as
// manual jobs, which never consult the catalogue), optionally uploaded.
export async function seedAnalysed(
	d: TestDevice,
	specs: ReadonlyArray<{ trackId: string; md5: string; durationSec?: number }>,
	opts: { upload?: boolean } = {},
): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	for (const s of specs) {
		const file = join(d.dir, 'music', `${s.trackId}.flac`);
		writeFlac(file, s.md5, `TITLE=${s.trackId}`);
		hashes.set(s.trackId, await addLocalTrack(d, s.trackId, file, s.durationSec ?? 30));
	}
	d.queue.enqueue(specs.map((s) => s.trackId), { priority: 100, analyzeOptions: { features: ['brightness'] } });
	await waitFor(() => specs.every((s) => jobState(d, s.trackId) === 'done'), 'seed analysis', 20_000);
	if (opts.upload) {
		await d.layer.syncNow();
		await d.layer.uploadNow();
	}
	return hashes;
}
