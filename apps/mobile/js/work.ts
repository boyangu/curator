// What the phone reads at the stores for the artist or label page in front
// ('catalog_device_work': the cloud plans, the device reads).
//
// A page of the catalogue read for the page in front says what the phone can
// read now (`profile`), and the cloud's answer may carry work: the entity's
// store page to read for new releases, a release's tracklist or its page at
// another store, a track's BPM, key and genre. The reading engine
// (@curator/catalog-work — the one the desktop runs) does it; this is its
// host on the phone, as apps/core entity/work.ts is on the desktop:
//   - one visit per page in front, twenty releases of work at most (the
//     cloud's cap for a phone), stopped when the page is left or the app goes
//     to the background (Kotlin calls `watch(null)`);
//   - what is found is told to Kotlin as it is found (`work` events): the
//     rows to patch, and when the cloud kept a report, that the page is to be
//     read again;
//   - Spotify is read with the account's token from the cloud's gateway (the
//     phone has no Web API grant of its own); Beatport through Kotlin's hidden
//     WebView; Deezer and Bandcamp by plain HTTP. Traxsource is not read here.
//
// A phone is never handed background work, and reads nothing for an entity
// the catalogue does not know: only what a page it opened asks for.

import { createWorkEngine, type WorkEngine, type WorkEngineDeps, type WorkEvent, type WorkPhase, type WorkRowPatch, type WorkVisit } from '@curator/catalog-work';
import type { CatalogDeviceProfile, CatalogTracksResult, CatalogWork, CatalogWorkReportInput, CatalogWorkReportResult } from '@curator/protocol';
import type { StoreVia } from './shim/store-fetch.js';

// Saves the cloud reports in a burst are one reload of the page.
const RELOAD_GAP_MS = 3000;
// How long the phone leaves Spotify out after the gateway said there is no
// grant to read with (connected on the desktop, or not at all).
const SPOTIFY_OFF_MS = 30 * 60_000;
// The first read of a page waits this long, at most, to learn whether there
// is a Spotify token: a profile that offers a store the phone cannot read is
// work handed out for nothing.
const READY_WAIT_MS = 2500;

export type PhoneWorkSettings = { enabled: boolean; beatport: boolean };

export type PhoneRowPatch = { recordingId: string; bpm?: number; keyCamelot?: string; genre?: string; label?: string; spotifyId?: string };
export type PhoneWorkStatus = { phase: WorkPhase | null; store: string | null; found: number; done: number; total: number };
// `watch`: the number Kotlin watched the page with. `changed`: the catalogue
// kept something of this page — read it again.
export type PhoneWorkEvent = { type: 'work'; watch: number; status: PhoneWorkStatus; rows?: PhoneRowPatch[]; changed?: true };

export type PhoneWorkDeps = {
	emit(event: PhoneWorkEvent): void;
	// Signed in, and the server hands out work.
	offered(): boolean;
	report(input: Omit<CatalogWorkReportInput, 'deviceId'>): Promise<CatalogWorkReportResult>;
	// The account's Spotify token from the cloud (cached by the caller); null
	// when the account has none to give. Throws when the cloud did not answer.
	spotifyToken(): Promise<string | null>;
	fetch(via: StoreVia): WorkEngineDeps['fetch'];
	now?: () => number;
	// Tests: the engine's own seams.
	engine?: Pick<WorkEngineDeps, 'readers' | 'sleep' | 'gaps' | 'callTimeoutMs'>;
};

export interface PhoneWork {
	settings(s: PhoneWorkSettings): void;
	// The page in front (null: none).
	watch(catalogId: string | null, token: number): void;
	// Resolves once the phone knows what it can read (its Spotify token asked
	// for), or after a short wait.
	ready(): Promise<void>;
	// What to say with a read of this object's page: null unless it is the
	// page in front and work is on.
	profile(catalogId: string): CatalogDeviceProfile | null;
	// A page the catalogue answered, with the work it carried.
	read(catalogId: string, result: Pick<CatalogTracksResult, 'releases'>, work: CatalogWork | undefined): void;
	patchOf(recordingId: string): PhoneRowPatch | undefined;
}

type Front = {
	catalogId: string;
	token: number;
	abort: AbortController;
	visit: WorkVisit;
	status: PhoneWorkStatus;
	running: number;
	// Whether each row of the page has a genre of its own.
	ownGenre: Map<string, boolean>;
	reloadAt: number;
	reloadTimer: ReturnType<typeof setTimeout> | null;
};

const IDLE: PhoneWorkStatus = { phase: null, store: null, found: 0, done: 0, total: 0 };

export function createPhoneWork(deps: PhoneWorkDeps): PhoneWork {
	const now = deps.now ?? Date.now;
	let settings: PhoneWorkSettings = { enabled: true, beatport: false };
	let front: Front | null = null;
	let spotifyOffUntil = 0;
	let warmed: Promise<void> | null = null;
	const found = new Map<string, PhoneRowPatch>();

	const token = async (): Promise<string | null> => {
		const t = await deps.spotifyToken();
		spotifyOffUntil = t ? 0 : now() + SPOTIFY_OFF_MS;
		return t;
	};

	const engine: WorkEngine = createWorkEngine({
		form: 'phone',
		enabled: () => settings.enabled && deps.offered(),
		allowed: (store) => (store === 'beatport' ? settings.beatport : store !== 'spotify' || spotifyOffUntil <= now()),
		fetch: deps.fetch('http'),
		beatportFetch: deps.fetch('beatport'),
		spotifyToken: token,
		report: deps.report,
		now,
		...deps.engine,
	});

	const emit = (f: Front, extra: Pick<PhoneWorkEvent, 'rows' | 'changed'> = {}): void => {
		// A page since left says nothing more.
		if (front !== f) return;
		deps.emit({ type: 'work', watch: f.token, status: { ...f.status }, ...extra });
	};
	const say = (f: Front, patch: Partial<PhoneWorkStatus>): void => {
		Object.assign(f.status, patch);
		emit(f);
	};

	// The catalogue kept what was reported: the page reads it again — once
	// for a burst of saves, and at the latest when the work goes quiet.
	const reload = (f: Front, at: 'save' | 'idle'): void => {
		if (front !== f) return;
		if (at === 'save' && f.reloadTimer) return;
		const fire = (): void => {
			f.reloadTimer = null;
			f.reloadAt = now();
			emit(f, { changed: true });
		};
		if (at === 'idle') {
			if (f.reloadTimer) {
				clearTimeout(f.reloadTimer);
				fire();
			}
			return;
		}
		f.reloadTimer = setTimeout(fire, Math.max(0, f.reloadAt + RELOAD_GAP_MS - now()));
	};

	const remember = (f: Front, rows: readonly WorkRowPatch[]): void => {
		const out: PhoneRowPatch[] = [];
		for (const r of rows) {
			const patch: PhoneRowPatch = { recordingId: r.recordingId };
			if (r.bpm) patch.bpm = r.bpm;
			if (r.keyCamelot) patch.keyCamelot = r.keyCamelot;
			// Beatport's genre stands over the row's own; any other store's only
			// fills a row that has none (as on the desktop).
			if (r.genre && (r.from === 'beatport' || !f.ownGenre.get(r.recordingId))) patch.genre = r.genre;
			if (r.label) patch.label = r.label;
			if (r.streamIds?.spotify) patch.spotifyId = r.streamIds.spotify;
			if (Object.keys(patch).length <= 1) continue;
			const merged = { ...found.get(r.recordingId), ...patch };
			found.set(r.recordingId, merged);
			out.push(merged);
		}
		if (out.length) emit(f, { rows: out });
	};

	const onEvent = (f: Front) => (e: WorkEvent): void => {
		switch (e.type) {
			case 'progress':
				say(f, { phase: e.phase, store: e.store, done: e.done, total: e.total });
				break;
			case 'found':
				say(f, { found: f.status.found + e.claims.length });
				break;
			case 'rows':
				remember(f, e.rows);
				break;
			case 'saved':
				reload(f, 'save');
				break;
			case 'refused':
				console.info('page work: the catalogue did not take some of it', JSON.stringify([...new Set(e.results.map((r) => r.note ?? r.outcome))].slice(0, 5)));
				break;
			case 'unsent':
				console.warn('page work not reported', e.error);
				break;
			case 'idle':
				break;
		}
	};

	const leave = (): void => {
		if (!front) return;
		front.abort.abort();
		if (front.reloadTimer) clearTimeout(front.reloadTimer);
		front = null;
	};

	return {
		settings(s) {
			settings = { enabled: s.enabled, beatport: s.beatport };
			if (!settings.enabled) leave();
		},

		watch(catalogId, token) {
			if (front && catalogId && front.catalogId === catalogId) {
				front.token = token;
				emit(front);
				return;
			}
			leave();
			if (!catalogId) return;
			front = { catalogId, token, abort: new AbortController(), visit: engine.visit(), status: { ...IDLE }, running: 0, ownGenre: new Map(), reloadAt: 0, reloadTimer: null };
		},

		ready() {
			if (!settings.enabled || !deps.offered()) return Promise.resolve();
			// Asked once a while: with a token in hand, or the word that there is none.
			warmed ??= token().then(
				() => undefined,
				() => {
					// The cloud did not answer: asked again with the next page.
					warmed = null;
				},
			);
			return Promise.race([warmed, new Promise<void>((r) => setTimeout(r, READY_WAIT_MS))]);
		},

		profile(catalogId) {
			const f = front;
			if (!f || f.catalogId !== catalogId || !settings.enabled || !deps.offered()) return null;
			return engine.profile(f.visit);
		},

		read(catalogId, result, work) {
			const f = front;
			if (!f || f.catalogId !== catalogId) return;
			for (const r of result.releases) for (const t of r.tracks) f.ownGenre.set(t.id, t.genres.length > 0);
			if (!work?.jobs.length) return;
			f.running++;
			void engine
				.run(work, { visit: f.visit, signal: f.abort.signal, onEvent: onEvent(f) })
				.catch((err: unknown) => console.warn('page work failed', err instanceof Error ? err.message : String(err)))
				.finally(() => {
					f.running--;
					if (f.running) return;
					reload(f, 'idle');
					if (f.status.phase !== null) say(f, { phase: null, store: null, done: 0, total: 0 });
				});
		},

		patchOf: (recordingId) => found.get(recordingId),
	};
}
