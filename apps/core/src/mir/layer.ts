// MirLayer — the engine's whole core-side surface, composed from the store,
// sidecar client, scheduler and vector index. CoreService delegates to this
// ("logic lives in the module, service.ts delegates", plays/plays.ts style).
//
// Disabled is a supported state (CLAUDE.md "Sidecars"): with no sidecar spec
// the layer still answers seed-based similarity from vectors already in
// mir.db; only computing new vectors and text queries need the engine.

import { log } from '../log.js';
import type { MirLibraryPort } from './library-port.js';
import { isProvisioned, runProvision, type MirProvisionSpec } from './provision.js';
import { MirScheduler } from './scheduler.js';
import { MirSidecar, type MirCapabilities, type MirSidecarSpec } from './sidecar.js';
import { SqliteMirStore } from './store.js';
import { normalise, VectorIndex } from './vector-index.js';
import {
	DEFAULT_MIR_SETTINGS, MIR_K_DEFAULT, MIR_K_MAX,
	type MirEvent, type MirModelInfo, type MirSettings, type MirStatus, type SimilarResult,
} from './types.js';

const mlog = log.for('mir');
// While a backfill writes vectors, re-read the matrix at most this often: a
// query that misses the last few seconds of new tracks is fine; reloading
// 20 MB on every query of a busy session is not.
const INDEX_RELOAD_MIN_MS = 5000;
const LOCAL_COUNT_TTL_MS = 30_000;

export interface MirLayerDeps {
	mirDbPath: string;
	sidecar?: MirSidecarSpec | null;
	// Packaged builds: how to create the env `sidecar.executable` lives in.
	provision?: MirProvisionSpec | null;
	library: MirLibraryPort;
	loadSettings: () => Partial<MirSettings> | null;
	saveSettings: (s: MirSettings) => void;
	busyElsewhere?: () => boolean;
}

export interface RankQuery {
	seeds?: string[];
	text?: string;
	model?: string;
	k?: number;
	allow?: ReadonlySet<string> | null; // candidate restriction (null = all)
	excludeSeeds?: boolean;
}

export interface MirLayer {
	status(): MirStatus;
	setSettings(patch: Partial<MirSettings>): MirStatus;
	analyzeNow(trackIds: string[]): { queued: number };
	provision(): Promise<MirStatus>;
	rank(q: RankQuery): Promise<SimilarResult>;
	trackVector(trackId: string, model?: string): number[] | null;
	subscribe(cb: (e: MirEvent) => void): () => void;
	// True while a track is being embedded — the backup scheduler yields to
	// it. Cheaper than status(), which runs a coverage query.
	isBusy(): boolean;
	onTracksDeleted(trackIds: string[]): void;
	onTrackMerged(loserId: string, winnerId: string): void;
	close(): Promise<void>;
}

function sanitize(raw: Partial<MirSettings> | null | undefined): MirSettings {
	const s = raw ?? {};
	const models = Array.isArray(s.models) ? s.models.filter((m) => typeof m === 'string' && m.length > 0) : [];
	return {
		enabled: s.enabled === true,
		executor: s.executor === 'cloud' ? 'cloud' : 'local',
		models: models.length > 0 ? [...new Set(models)] : [...DEFAULT_MIR_SETTINGS.models],
	};
}

export function createMirLayer(deps: MirLayerDeps): MirLayer {
	const store = new SqliteMirStore(deps.mirDbPath);
	let settings = sanitize(deps.loadSettings());
	const listeners = new Set<(e: MirEvent) => void>();
	const emit = (e: MirEvent): void => { for (const l of listeners) { try { l(e); } catch (err) { mlog.error('listener threw', err); } } };

	let caps: MirCapabilities | null = null;
	const sidecar = deps.sidecar ? new MirSidecar(deps.sidecar) : null;

	// key -> modelId: the live engine's registry when it has spoken, else the
	// newest model of that key recorded in mir.db (vectors outlive the engine).
	const modelId = (key: string): string | null => {
		const live = caps?.models.find((m) => m.key === key);
		if (live) return live.modelId;
		const known = store.knownModels().filter((m) => m.key === key);
		return known.length ? known[known.length - 1]!.modelId : null;
	};
	const modelInfos = (): MirModelInfo[] => caps
		? caps.models.map((m) => ({ ...m }))
		: store.knownModels().map((m) => ({ key: m.key, modelId: m.modelId, dim: m.dim, sampleRate: 0, text: m.text, license: '', repo: '', summary: '' }));

	let statusTimer: NodeJS.Timeout | null = null;
	let closed = false;
	const statusChanged = (): void => {
		// The engine's 'exit' during shutdown would otherwise schedule a status
		// read against an already-closed curator.db.
		if (statusTimer || closed) return;
		statusTimer = setTimeout(() => { statusTimer = null; emit({ kind: 'status', status: status() }); }, 250);
	};

	const scheduler = sidecar ? new MirScheduler({
		store, sidecar, library: deps.library, settings: () => settings, modelId,
		onChange: statusChanged, onEvent: emit, ...(deps.busyElsewhere ? { busyElsewhere: deps.busyElsewhere } : {}),
	}) : null;

	if (sidecar) {
		sidecar.on('ready', () => {
			sidecar.capabilities()
				.then((c) => {
					caps = c;
					for (const m of c.models) store.upsertModel(m);
					mlog.info('engine ready', { device: c.device, torch: c.torch, cloud: c.cloudConfigured });
					scheduler!.invalidate();
					scheduler!.kick();
				})
				.catch((err) => mlog.error('capabilities failed', err))
				.finally(statusChanged);
		});
		sidecar.on('exit', statusChanged);
		sidecar.on('disabled', statusChanged);
		// Don't spawn an executable that doesn't exist yet (unprovisioned
		// packaged build): ENOENT would burn the respawn budget for nothing.
		if (!deps.provision || isProvisioned(deps.provision)) sidecar.start();
	}
	let provisioning = false;
	let provisionLog: string | null = null;
	const needsProvision = (): boolean => !!deps.provision && !isProvisioned(deps.provision);

	// Orphan sweep off the boot path: rows for tracks deleted outside the
	// lifecycle hooks (repair scripts, a crash between the two DB writes).
	const sweepTimer = setTimeout(() => {
		try {
			const n = store.pruneOrphans(deps.library.isLive);
			if (n > 0) mlog.info('swept orphaned engine rows', { tracks: n });
		} catch (err) { mlog.error('orphan sweep failed', err); }
	}, 15_000);

	let localCount: { n: number; at: number } | null = null;
	const localTracks = (): number => {
		if (!localCount || Date.now() - localCount.at > LOCAL_COUNT_TTL_MS) {
			localCount = { n: deps.library.playableTrackIds().length, at: Date.now() };
		}
		return localCount.n;
	};

	function status(): MirStatus {
		const unprovisioned = needsProvision();
		// 'ready' only once capabilities landed: before that no model can be
		// resolved, so the engine can't take work yet.
		const state = !sidecar || unprovisioned ? 'disabled' : sidecar.disabled ? 'unavailable' : sidecar.ready && caps ? 'ready' : 'starting';
		const reason = !sidecar ? 'AI engine not installed (apps/mir environment not found)'
			: unprovisioned ? 'AI engine not set up yet'
			: sidecar.disabled ? 'AI engine failed to start — see the session log'
			: scheduler?.blocked ?? null;
		return {
			state, reason,
			device: caps?.device ?? null,
			cloudConfigured: caps?.cloudConfigured ?? false,
			settings: { ...settings, models: [...settings.models] },
			models: modelInfos(),
			coverage: { localTracks: localTracks(), perModel: store.coverage() },
			running: scheduler?.running ?? null,
			pending: scheduler ? scheduler.pendingCount() : 0,
			sessionDone: scheduler?.sessionDone ?? 0,
			lastError: scheduler?.lastError ?? null,
			provisionable: unprovisioned,
			provisioning,
			provisionLog,
		};
	}

	const indexes = new Map<string, { version: number; at: number; index: VectorIndex }>();
	const indexFor = (mid: string): VectorIndex => {
		const v = store.indexVersion();
		const cached = indexes.get(mid);
		if (cached && (cached.version === v || Date.now() - cached.at < INDEX_RELOAD_MIN_MS)) return cached.index;
		const index = new VectorIndex(store.loadTrackMatrix(mid));
		indexes.set(mid, { version: v, at: Date.now(), index });
		return index;
	};

	async function rank(q: RankQuery): Promise<SimilarResult> {
		const seeds = q.seeds ?? [];
		const text = q.text?.trim() ?? '';
		if (seeds.length === 0 && !text) return { model: null, items: [], missingSeeds: [] };
		const k = Math.min(Math.max(Math.floor(q.k ?? MIR_K_DEFAULT), 1), MIR_K_MAX);
		const exclude = q.excludeSeeds === false ? undefined : new Set(seeds);
		const infos = modelInfos();
		const withVectors = (key: string): string | null => {
			const mid = modelId(key);
			return mid && indexFor(mid).size > 0 ? mid : null;
		};
		// Seed-only queries with no explicit model blend every enabled model
		// that has vectors: in the Phase 0 bake-off MERT-v2 + MuQ-MuLan
		// together beat either alone on the user's tags and DJ-set adjacency.
		if (!q.model && !text) {
			const mids = settings.models.map(withVectors).filter((m): m is string => m !== null);
			if (mids.length > 1) return blend(mids, seeds, k, q.allow ?? null, exclude);
		}
		// Single model: the requested one; for text the first enabled model
		// with a text tower (text and audio share its raw space).
		const key = q.model ?? (text
			? settings.models.find((m) => infos.find((i) => i.key === m)?.text) ?? infos.find((i) => i.text)?.key
			: settings.models.find((m) => withVectors(m)) ?? settings.models[0]);
		const mid = key ? modelId(key) : null;
		if (!key || !mid) return { model: null, items: [], missingSeeds: seeds };
		const index = indexFor(mid);
		const space = text ? 'raw' : 'centred';
		const missingSeeds = seeds.filter((id) => !index.has(id));
		let query: Float32Array | null = seeds.length ? index.centroid(seeds, space) : null;
		if (text) {
			if (!sidecar?.ready) throw new Error('Text search needs the AI engine running');
			const r = await sidecar.textEmbed(key, [text]);
			const b = Buffer.from(r.vecs[0]!, 'base64');
			const tv = new Float32Array(b.byteLength >>> 2);
			new Uint8Array(tv.buffer).set(b);
			normalise(tv, 0, tv.length);
			if (query) { for (let d = 0; d < tv.length; d++) query[d]! += tv[d]!; normalise(query, 0, query.length); }
			else query = tv;
		}
		if (!query) return { model: mid, items: [], missingSeeds };
		const items = index.topK(query, k, q.allow ?? null, exclude, space).map((r) => ({ trackId: r.id, score: r.score }));
		return { model: mid, items, missingSeeds };
	}

	// Mean of each model's centred cosine to its own seed centroid, over the
	// models that have a vector for the candidate (coverage-aware: a track one
	// model hasn't reached yet still ranks on the others).
	function blend(mids: string[], seeds: string[], k: number, allow: ReadonlySet<string> | null,
		exclude: ReadonlySet<string> | undefined): SimilarResult {
		const acc = new Map<string, { sum: number; n: number }>();
		const seen = new Set<string>();
		const used: string[] = [];
		for (const mid of mids) {
			const index = indexFor(mid);
			for (const id of seeds) if (index.has(id)) seen.add(id);
			const c = index.centroid(seeds);
			if (!c) continue;
			used.push(mid);
			const scores = index.scoreAll(c);
			for (let i = 0; i < index.ids.length; i++) {
				const id = index.ids[i]!;
				if ((allow && !allow.has(id)) || exclude?.has(id)) continue;
				const a = acc.get(id);
				if (a) { a.sum += scores[i]!; a.n++; } else acc.set(id, { sum: scores[i]!, n: 1 });
			}
		}
		const items = [...acc].map(([trackId, a]) => ({ trackId, score: a.sum / a.n }))
			.sort((x, y) => y.score - x.score).slice(0, k);
		return { model: used.length ? used.join('+') : null, items, missingSeeds: seeds.filter((id) => !seen.has(id)) };
	}

	return {
		status,
		setSettings(patch) {
			settings = sanitize({ ...settings, ...patch });
			deps.saveSettings(settings);
			scheduler?.invalidate();
			scheduler?.unblock();
			scheduler?.kick();
			statusChanged();
			return status();
		},
		analyzeNow(trackIds) {
			if (!scheduler) throw new Error('AI engine not installed');
			const queued = scheduler.analyzeNow(trackIds);
			statusChanged();
			return { queued };
		},
		async provision() {
			if (!deps.provision || !sidecar) throw new Error('This build runs the engine from the source tree — nothing to set up');
			if (!provisioning) {
				provisioning = true;
				statusChanged();
				try {
					await runProvision(deps.provision, (line) => { provisionLog = line; statusChanged(); });
					provisionLog = null;
					sidecar.start();
				} catch (err) {
					provisionLog = err instanceof Error ? err.message : String(err);
					throw err;
				} finally {
					provisioning = false;
					statusChanged();
				}
			}
			return status();
		},
		rank,
		trackVector(trackId, model) {
			const mid = modelId(model ?? settings.models[0]!);
			const v = mid ? store.trackVector(trackId, mid) : null;
			return v ? Array.from(v) : null;
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		isBusy() {
			return scheduler?.running != null;
		},
		onTracksDeleted(trackIds) {
			store.deleteTracks(trackIds);
			scheduler?.invalidate();
			localCount = null;
		},
		onTrackMerged(loserId, winnerId) {
			store.moveTrack(loserId, winnerId);
			scheduler?.invalidate();
			localCount = null;
		},
		async close() {
			closed = true;
			clearTimeout(sweepTimer);
			if (statusTimer) clearTimeout(statusTimer);
			scheduler?.stop();
			await sidecar?.shutdown();
			store.close();
		},
	};
}
