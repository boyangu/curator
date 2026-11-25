// The phone's sync core: the desktop's sync client and library writers
// (@curator/sync-core), unchanged, behind the few calls the app makes.
//
// Kotlin (core/CoreRuntime.kt) owns the one thread this runs on. It calls
// `__dispatch(name, argJson, callId)`; each call answers once through
// `emit({ type: 'result', id, ok, value | error })`. Between calls the core
// emits `phase`, `status`, `applied` and `feed` events, which the app's
// repositories turn into refreshes. HTTP goes out through Kotlin and comes back through
// `__httpDone`.
//
// Every edit here is a library write the desktop makes the same way, so it
// becomes the same op (D4): a rating, an Interested / Basket tag, a setting,
// a feed card archived or taken into the library. None reaches Spotify, Tidal or rekordbox from the phone; a desktop pushes
// those upstream on its own terms.

import './shim/globals.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fetchPeaks } from '@curator/sync-core/catalogue/peaks';
import { createDb, type Db } from '@curator/sync-core/db/client';
import { getDeviceId } from '@curator/sync-core/sync-log/device';
import { migrate } from '@curator/sync-core/db/migrate';
import { createDeviceFeed, queueKnownSuppressions, type DeviceFeed, type FeedArtistRef, type FeedInterestedInput } from '@curator/sync-core/feed/device-feed';
import { SqliteFeedStore } from '@curator/sync-core/feed/store';
import { applyPendingFeedDecisionsAsync, backfillFeedDecisionsAsync, feedBackfillPending, feedPendingCount, syncedItemsFor } from '@curator/sync-core/feed/sync';
import { setRating, setSetting, tagTracks, untagTracks } from '@curator/sync-core/library/mutators';
import { createSyncClient, type SyncClient } from '@curator/sync-core/sync-log/client';
import { createFetchCloudTransport } from '@curator/sync-core/sync-log/fetch-transport';
import { joinFromReplica } from '@curator/sync-core/sync-log/replica';
import { host } from './shim/host.js';
import type Database from 'better-sqlite3';

type StartConfig = {
	dbPath: string;
	// The Discover feed's own database (the views read it too) and where its
	// watch list is kept between runs.
	feedDbPath: string;
	feedWatchesPath: string;
	// Where fetched waveform peaks are cached, one <track id>.cpk each
	// (the Track view reads them there: ui/track/PeaksLoader.kt).
	peaksDir: string;
	apiUrl: string;
	userId: string;
	token: string;
	deviceName: string;
	appVersion: string;
};

const g = globalThis as Record<string, unknown>;
const emit = (event: Record<string, unknown>): void => host.emit(JSON.stringify(event));

// ── HTTP through Kotlin ──────────────────────────────────────────────────────

type HttpAnswer = { status: number; bytes: Uint8Array };
const inflight = new Map<number, { resolve: (a: HttpAnswer) => void; reject: (e: Error) => void }>();
let nextHttp = 1;

function http(method: string, url: string, headers: Record<string, string>, body?: string): Promise<HttpAnswer> {
	const id = nextHttp++;
	return new Promise((resolve, reject) => {
		inflight.set(id, { resolve, reject });
		host.httpStart(id, method, url, JSON.stringify(headers), body ?? null);
	});
}

// Kotlin's answer: a status and the (inflated) body, or why there is none.
g['__httpDone'] = (id: number, status: number, body: ArrayBuffer | null, error: string | null): void => {
	const p = inflight.get(id);
	if (!p) return;
	inflight.delete(id);
	if (error !== null) p.reject(new Error(error));
	else p.resolve({ status, bytes: new Uint8Array(body ?? new ArrayBuffer(0)) });
};

// ── the snapshot's text, inflated a megabyte at a time ───────────────────────

// A piece of bytes may end inside a character: those bytes wait for the next.
function* inflateText(body: Uint8Array): Iterable<string> {
	const handle = host.inflateOpen(body);
	let carry = new Uint8Array(0);
	for (;;) {
		const next = host.inflateRead(handle, 1 << 20);
		if (next === null) break;
		let bytes = new Uint8Array(next);
		if (carry.length > 0) {
			const joined = new Uint8Array(carry.length + bytes.length);
			joined.set(carry);
			joined.set(bytes, carry.length);
			bytes = joined;
		}
		let end = bytes.length;
		let i = end - 1;
		while (i >= 0 && end - i <= 3 && (bytes[i]! & 0xc0) === 0x80) i--;
		if (i >= 0) {
			const lead = bytes[i]!;
			const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
			if (end - i < need) end = i;
		}
		carry = bytes.slice(end);
		if (end > 0) yield host.utf8Decode(bytes.subarray(0, end));
	}
	if (carry.length > 0) yield host.utf8Decode(carry);
}

// ── the library ──────────────────────────────────────────────────────────────

let library: { db: Db; raw: Database.Database; client: SyncClient; transport: ReturnType<typeof createFetchCloudTransport>; feed: DeviceFeed; cfg: StartConfig } | null = null;

function transportFor(cfg: StartConfig) {
	const auth = { authorization: `Bearer ${cfg.token}` };
	let signedIn = true;
	return createFetchCloudTransport({
		apiUrl: cfg.apiUrl,
		request: async (req) => {
			const res = await http(req.method, req.url, req.headers, req.body);
			return { status: res.status, body: host.utf8Decode(res.bytes) };
		},
		session: () => (signedIn ? { userId: cfg.userId, email: null } : null),
		accessToken: async () => cfg.token,
		signOut: async () => { signedIn = false; },
		// The local test server serves the bucket's bytes under /storage
		// (research/mobile/sync-core-spike/scripts/serve-cloud.ts); Supabase
		// Storage with the user's token comes with real sign-in.
		snapshots: {
			upload: async () => { throw new Error('a phone publishes no snapshot'); },
			remove: async () => {},
			download: async (path) => {
				const res = await http('GET', `${cfg.apiUrl}/storage/${path}`, auth);
				if (res.status !== 200) throw new Error(`storage answered ${res.status} for ${path}`);
				return res.bytes;
			},
		},
		inflate: (body) => inflateText(body),
		client: `android/${cfg.appVersion}`,
	});
}

async function start(cfg: StartConfig): Promise<Record<string, unknown>> {
	if (library) return { already: true };
	const transport = transportFor(cfg);
	let installed: Record<string, unknown> | null = null;
	if (!existsSync(cfg.dbPath)) {
		emit({ type: 'phase', phase: 'installing' });
		// The master's ready-made library when the account has one; else an
		// empty one, which the client fills from the snapshot (a normal join).
		const r = await joinFromReplica(transport, cfg.dbPath);
		if (r) installed = { snapshotSeq: r.snapshotSeq, parts: r.parts, ms: r.ms };
	}
	emit({ type: 'phase', phase: 'opening' });
	const tm = performance.now();
	migrate(cfg.dbPath);
	console.debug(`migrate at open: ${Math.round(performance.now() - tm)} ms`);
	const { db, sqlite } = createDb(cfg.dbPath);
	// A library just installed was projected elsewhere, and a new feed.db has
	// applied nothing: either way its mutes are not in here yet.
	const behind = installed !== null || !existsSync(cfg.feedDbPath);
	const feedStore = new SqliteFeedStore(cfg.feedDbPath);
	feedStore.setDecisionSource((keys) => syncedItemsFor(sqlite, keys));
	if (behind) queueKnownSuppressions(sqlite);
	const client = createSyncClient({
		db: sqlite,
		transport,
		device: { name: cfg.deviceName, platform: 'android' },
		// The account's feed decisions, onto this phone's feed.db.
		feed: {
			pending: () => feedPendingCount(sqlite),
			applyPending: async () => {
				const r = await applyPendingFeedDecisionsAsync(sqlite, feedStore);
				// Mutes change what shows without changing an item's row.
				if (r.keys > 0) emit({ type: 'feed' });
				return r;
			},
			backfillPending: () => feedBackfillPending(sqlite),
			backfill: (o) => backfillFeedDecisionsAsync(sqlite, feedStore, o),
		},
		onApplied: (a) => emit({ type: 'applied', tracks: a.tracks.length, playlists: a.playlists.length, entities: a.entities.map((e) => e.entity) }),
	});
	const feed = createDeviceFeed({
		db, raw: sqlite, store: feedStore,
		feed: transport.feed!,
		catalog: transport.catalog!,
		available: () => transport.session() !== null && (client.serverFeatures()?.includes('global_catalog') ?? false),
		deviceId: () => client.deviceId(),
		cache: {
			read: () => (existsSync(cfg.feedWatchesPath) ? readFileSync(cfg.feedWatchesPath, 'utf8') : null),
			write: (text) => {
				writeFileSync(`${cfg.feedWatchesPath}.part`, text);
				renameSync(`${cfg.feedWatchesPath}.part`, cfg.feedWatchesPath);
			},
		},
		onChanged: () => emit({ type: 'feed' }),
	});
	client.subscribe(() => {
		feed.onStatus();
		const s = client.status();
		emit({ type: 'status', lastSeq: s.lastSeq, pending: s.pending, error: s.lastError, bootstrap: s.bootstrap ?? null });
	});
	library = { db, raw: sqlite, client, transport, feed, cfg };
	client.start();
	emit({ type: 'phase', phase: 'ready' });
	return { installed };
}

function lib(): NonNullable<typeof library> {
	if (!library) throw new Error('the library is not open yet');
	return library;
}

// After a write: the op is in the outbox; a cycle pushes it soon.
function wrote(): void {
	lib().client.wake('local');
	emit({ type: 'applied', tracks: 1, playlists: 0, entities: ['local'] });
}

const CALLS: Record<string, (arg: Record<string, unknown>) => unknown> = {
	start: (a) => start(a as unknown as StartConfig),
	setRating: (a) => { setRating(lib().db, [a['trackId'] as string], (a['rating'] as number | null) ?? null); wrote(); },
	setTag: (a) => {
		const ids = [a['trackId'] as string];
		if (a['on']) tagTracks(lib().db, ids, a['tagId'] as string, { bump: true });
		else untagTracks(lib().db, ids, a['tagId'] as string, { bump: true });
		wrote();
	},
	// Not interested on the phone takes the Interested tag off and deletes
	// nothing (decided 2026-11-23): a delete would reach the desktop's
	// rekordbox and streaming pushes as a remote delete. Deleting stays a
	// desktop action, with its confirmation.
	notInterested: (a) => { untagTracks(lib().db, [a['trackId'] as string], 'interested', { bump: true }); wrote(); },
	setSetting: (a) => { setSetting(lib().db, a['key'] as string, a['value']); wrote(); },
	// A track's waveform from the account's analysis catalogue, cached for the
	// views; answers the tier it got, or null when the account has none.
	fetchPeaks: async (a) => {
		const { raw, transport, cfg } = lib();
		const trackId = a['trackId'] as string;
		if (!transport.catalogue || !transport.snapshots) return null;
		const got = await fetchPeaks({
			raw, deviceId: getDeviceId(raw),
			lookup: (input) => transport.catalogue!.lookup(input),
			// The test server serves both buckets' bytes under /storage.
			download: (path) => transport.snapshots!.download(path),
		}, trackId);
		if (!got) return null;
		mkdirSync(cfg.peaksDir);
		const file = `${cfg.peaksDir}/${trackId}.cpk`;
		writeFileSync(`${file}.part`, got.bytes);
		renameSync(`${file}.part`, file);
		return got.tier;
	},
	syncNow: () => lib().client.syncNow(),
	setActive: (a) => { lib().client.setActive(!!a['active']); lib().feed.setActive(!!a['active']); },

	// ── the feed ──
	feedRefresh: () => lib().feed.refresh(),
	feedArchive: async (a) => { await lib().feed.archive(a['itemId'] as string); lib().client.wake('local'); },
	feedMuteArtist: async (a) => { await lib().feed.muteArtist(a['itemId'] as string, a['artistKey'] as string); lib().client.wake('local'); },
	feedPlayed: async (a) => { await lib().feed.played(a['itemId'] as string, (a['sourceTrackId'] as string | null) ?? null); lib().client.wake('local'); },
	// Answers the library track's id, or why there is none.
	feedInterested: async (a) => {
		const r = await lib().feed.interested(a as unknown as FeedInterestedInput);
		if (r.ok) wrote();
		return r;
	},
	feedArtists: (a) => lib().feed.artistPictures(a['refs'] as FeedArtistRef[]),
};

g['__dispatch'] = (name: string, argJson: string, id: number): void => {
	const fn = CALLS[name];
	const answer = (ok: boolean, value: unknown): void => emit({ type: 'result', id, ok, ...(ok ? { value: value ?? null } : { error: value }) });
	if (!fn) { answer(false, `no call ${name}`); return; }
	try {
		const r = fn(JSON.parse(argJson) as Record<string, unknown>);
		if (r && typeof (r as Promise<unknown>).then === 'function') {
			(r as Promise<unknown>).then((v) => answer(true, v), (e: unknown) => answer(false, e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)));
		} else answer(true, r);
	} catch (e) {
		answer(false, e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
	}
};
