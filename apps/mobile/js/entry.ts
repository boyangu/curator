// The phone's sync core: the desktop's sync client and library writers
// (@curator/sync-core), unchanged, behind the few calls the app makes.
//
// Kotlin (core/CoreRuntime.kt) owns the one thread this runs on. It calls
// `__dispatch(name, argJson, callId)`; each call answers once through
// `emit({ type: 'result', id, ok, value | error })`. Between calls the core
// emits `phase`, `status`, `applied` and `feed` events, which the app's
// repositories turn into refreshes, `session` (the account to keep, Kotlin's
// to seal) and `log` (a record for the phone's own log). HTTP goes out through
// Kotlin and comes back through `__httpDone`.
//
// The account comes first: `boot` takes what was kept of it, `signIn*` opens
// one, and `open` then opens (or first installs) its library. A library is
// open with or without a live session; without one it only does not sync.
// Nothing closes a library again: `signOut` ends the account and the app
// restarts, wiping it on the way up (CuratorApp.kt).
//
// Every edit here is a library write the desktop makes the same way, so it
// becomes the same op (D4): a rating, an Interested / Basket tag, a setting,
// a feed card archived or taken into the library. None reaches Spotify, Tidal or rekordbox from the phone; a desktop pushes
// those upstream on its own terms.

import './shim/globals.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { CATALOGUE_BUCKET, SNAPSHOT_BUCKET } from '@curator/protocol';
import { consoleSink, createLogger } from '@curator/shared/log';
import { AuthError, createGotrue, type AuthAccount, type Gotrue } from '@curator/sync-core/auth/gotrue';
import { fetchPeaks } from '@curator/sync-core/catalogue/peaks';
import { createDb, type Db } from '@curator/sync-core/db/client';
import { getDeviceId } from '@curator/sync-core/sync-log/device';
import { migrate, setMigrationBackups } from '@curator/sync-core/db/migrate';
import { createDeviceFeed, queueKnownSuppressions, type DeviceFeed, type FeedArtistRef, type FeedInterestedInput } from '@curator/sync-core/feed/device-feed';
import { SqliteFeedStore } from '@curator/sync-core/feed/store';
import { applyPendingFeedDecisionsAsync, backfillFeedDecisionsAsync, feedBackfillPending, feedPendingCount, syncedItemsFor } from '@curator/sync-core/feed/sync';
import { setRating, setSetting, tagTracks, untagTracks } from '@curator/sync-core/library/mutators';
import { setCoreLogger } from '@curator/sync-core/log';
import { CloudTransportError, createSyncClient, type SyncClient } from '@curator/sync-core/sync-log/client';
import { createFetchCloudTransport } from '@curator/sync-core/sync-log/fetch-transport';
import { joinFromReplica } from '@curator/sync-core/sync-log/replica';
import { createStorageDownload, StorageGoneError } from '@curator/sync-core/sync-log/supabase-storage';
import { host } from './shim/host.js';
import { trackPictures } from './track-pictures.js';
import { entityFollow, entityPage, entityTracks, type EntityDeps, type PageAsk } from './entity.js';
import { createStoreFetch, type StoreAnswer } from './shim/store-fetch.js';
import { createPhoneWork, type PhoneWork } from './work.js';
import type Database from 'better-sqlite3';

type BootConfig = {
	dbPath: string;
	// The Discover feed's own database (the views read it too) and where its
	// watch list is kept between runs.
	feedDbPath: string;
	feedWatchesPath: string;
	// Where fetched waveform peaks are cached, one <track id>.cpk each
	// (the Track view reads them there: ui/track/PeaksLoader.kt).
	peaksDir: string;
	apiUrl: string;
	supabaseUrl: string;
	publishableKey: string;
	// What the last run kept (its `session` events); null: signed out.
	account: AuthAccount | null;
	deviceName: string;
	appVersion: string;
};

const g = globalThis as Record<string, unknown>;
const emit = (event: Record<string, unknown>): void => host.emit(JSON.stringify(event));

// ── the log ──────────────────────────────────────────────────────────────────

// Everything to logcat; info and above to the phone's own log, which its
// owner may let it send (Kotlin diag/).
const RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;
setCoreLogger(createLogger({
	proc: 'phone-core',
	level: 'debug',
	replayBuffer: 0,
	sinks: [consoleSink(), { write: (rec) => { if (RANK[rec.level] >= RANK.info) emit({ type: 'log', record: rec }); } }],
}));

setMigrationBackups(false);

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

// ── the account and its library ──────────────────────────────────────────────

let account: { auth: Gotrue; cfg: BootConfig } | null = null;
let library: { db: Db; raw: Database.Database; client: SyncClient; transport: ReturnType<typeof createFetchCloudTransport>; feed: DeviceFeed; cfg: BootConfig; blob: (bucket: string, path: string) => Promise<Uint8Array> } | null = null;

function boot(cfg: BootConfig): { signedIn: boolean } {
	if (!account) {
		let live = !!cfg.account?.tokens;
		const auth = createGotrue({
			supabaseUrl: cfg.supabaseUrl,
			publishableKey: cfg.publishableKey,
			request: async (req) => {
				const res = await http(req.method, req.url, req.headers, req.body);
				return { status: res.status, body: host.utf8Decode(res.bytes) };
			},
			initial: cfg.account,
			holdsLibrary: () => existsSync(cfg.dbPath),
			onChange: (a) => {
				emit({ type: 'session', account: a });
				// Signed in again, or the session is over (not a mere refresh): the
				// client's status says so.
				if (live !== !!a?.tokens && library) library.client.wake('session');
				live = !!a?.tokens;
			},
		});
		account = { auth, cfg };
	}
	return { signedIn: !!account.auth.account()?.tokens };
}

function acct(): NonNullable<typeof account> {
	if (!account) throw new Error('not booted');
	return account;
}

// The auth client's refusals in the words the sync client branches on.
async function tokenFor(auth: Gotrue, opts?: { refresh?: boolean }): Promise<string | null> {
	try {
		return await auth.accessToken(opts);
	} catch (err) {
		if (!(err instanceof AuthError)) throw err;
		throw new CloudTransportError(err.code === 'network' || err.code === 'server' || err.status === 429 ? 'network' : 'auth', err.code);
	}
}

function transportFor({ auth, cfg }: NonNullable<typeof account>) {
	const blob = createStorageDownload({
		supabaseUrl: cfg.supabaseUrl,
		publishableKey: cfg.publishableKey,
		get: (url, headers) => http('GET', url, headers),
		accessToken: (o) => tokenFor(auth, o),
		utf8: (bytes) => host.utf8Decode(bytes),
	});
	const transport = createFetchCloudTransport({
		apiUrl: cfg.apiUrl,
		request: async (req) => {
			const res = await http(req.method, req.url, req.headers, req.body);
			return { status: res.status, body: host.utf8Decode(res.bytes) };
		},
		session: () => {
			const a = auth.account();
			return a?.tokens ? { userId: a.userId, email: a.email } : null;
		},
		accessToken: (o) => tokenFor(auth, o),
		// The client's unlink: the session ends, the library stays its owner's.
		signOut: () => auth.endSession(),
		snapshots: {
			upload: async () => { throw new Error('a phone publishes no snapshot'); },
			remove: async () => {},
			download: (path) => blob(SNAPSHOT_BUCKET, path),
		},
		partGone: (err) => err instanceof StorageGoneError,
		inflate: (body) => inflateText(body),
		client: `android/${cfg.appVersion}`,
	});
	return { transport, blob };
}

async function signedIn(a: Promise<AuthAccount>): Promise<{ email: string | null }> {
	return { email: (await a).email };
}

// Ends the account on this phone. What was edited and not sent gets a moment
// to go up; offline it is lost with the library, which the caller said.
async function signOut(): Promise<void> {
	const { auth } = acct();
	if (library) {
		const { client, feed } = library;
		feed.setActive(false);
		const moment = new Promise<void>((r) => { setTimeout(r, 8_000); });
		await Promise.race([client.syncNow().then(() => {}, () => {}), moment]);
		// Takes this phone off the account's devices too.
		await client.unlink().catch((err: unknown) => { console.warn('unlink failed', err instanceof Error ? err.message : String(err)); });
		client.stop();
	}
	await auth.signOut();
}

// Opens the account's library, once; installs it first on a phone without one.
// May be called again after it failed (offline during the install, say).
let opening: Promise<Record<string, unknown>> | null = null;
function open(): Promise<Record<string, unknown>> {
	opening ??= openLibrary().finally(() => { opening = null; });
	return opening;
}

async function openLibrary(): Promise<Record<string, unknown>> {
	if (library) return { already: true };
	const { cfg } = acct();
	const { transport, blob } = transportFor(acct());
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
		emit({ type: 'status', lastSeq: s.lastSeq, pending: s.pending, error: s.lastError, signedIn: s.signedIn, revoked: s.revoked, needsUpdate: s.needsUpdate, waiting: s.phase === 'waiting_for_snapshot', joining: s.bootstrap !== null });
	});
	library = { db, raw: sqlite, client, transport, feed, cfg, blob };
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
	// ── the account ──
	boot: (a) => boot(a as unknown as BootConfig),
	signInPassword: (a) => signedIn(acct().auth.signInPassword(a['email'] as string, a['password'] as string)),
	requestCode: (a) => acct().auth.requestCode(a['email'] as string),
	verifyCode: (a) => signedIn(acct().auth.verifyCode(a['email'] as string, a['code'] as string)),
	setPassword: (a) => acct().auth.setPassword(a['password'] as string),
	// A token for the log upload, which Kotlin sends itself; null: signed out.
	accessToken: () => acct().auth.accessToken(),
	// This phone was removed from the account: a fresh device id, and the
	// session that acted as the removed one ended. Signing in carries on.
	relink: async () => { await lib().client.unlink(); },
	signOut: () => signOut(),
	open: () => open(),

	// ── the library ──
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
		const { raw, transport, cfg, blob } = lib();
		const trackId = a['trackId'] as string;
		if (!transport.catalogue) return null;
		const got = await fetchPeaks({
			raw, deviceId: getDeviceId(raw),
			lookup: (input) => transport.catalogue!.lookup(input),
			download: (path) => blob(CATALOGUE_BUCKET, path),
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

	// ── the player ──
	// A track's artist and label pictures from the Global Catalog; null when
	// the catalogue can't be asked now (signed out, or a server without it).
	trackPictures: async (a) => {
		const { raw, client, transport } = lib();
		const features = client.serverFeatures();
		if (transport.session() === null || !features?.includes('global_catalog')) return null;
		return trackPictures(raw, transport.catalog!, { deviceId: client.deviceId(), brief: features.includes('catalog_pages') }, a['trackId'] as string);
	},

	// ── artist and label pages (js/entity.ts) ──
	entityPage: (a) => entityPage(entityDeps(), a as unknown as PageAsk),
	entityTracks: (a) => entityTracks(entityDeps(), a as unknown as Parameters<typeof entityTracks>[1]),
	// ── store reading for the page in front (js/work.ts) ──
	// The page shown (catalogId null: none — left, or the app in the background).
	entityWatch: (a) => phoneWork().watch((a['catalogId'] as string | null) ?? null, (a['watch'] as number) ?? 0),
	// The user's switch, and whether Kotlin's hidden WebView can read Beatport.
	workSettings: (a) => phoneWork().settings({ enabled: a['enabled'] === true, beatport: a['beatport'] === true }),
	// Kotlin's answer to a `fetch` event (core/StoreFetch.kt).
	fetchDone: (a) => storeFetch.done(a as unknown as StoreAnswer),
	// The account's watch list only: never a follow at Spotify (2026-11-26).
	entityFollow: async (a) => {
		const r = await entityFollow(entityDeps(), a as unknown as Parameters<typeof entityFollow>[1]);
		lib().feed.watchesChanged();
		return r;
	},
};

// What an entity page may ask the catalogue, and why not when it may not.
function entityDeps(): EntityDeps {
	const { raw, client, transport } = lib();
	const features = client.serverFeatures();
	const catalog: EntityDeps['catalog'] =
		transport.session() === null ? { reason: 'signed_out' }
			: features === null ? { reason: 'server_off' }
				: !features.includes('global_catalog') || !transport.catalog ? { reason: 'old_server' }
					: { client: transport.catalog, deviceId: client.deviceId(), pages: features.includes('catalog_pages') };
	return { raw, catalog, work: phoneWork(), now: Date.now() };
}

// ── store reading for the page in front ──────────────────────────────────────

const storeFetch = createStoreFetch(emit);

// The account's Spotify token from the cloud's gateway, kept until a minute
// before it ends. Null: the account has no grant to read with.
let spotifyToken: { value: string; until: number } | null = null;
async function gatewayToken(): Promise<string | null> {
	if (spotifyToken && spotifyToken.until > Date.now()) return spotifyToken.value;
	const { client, transport } = lib();
	if (transport.session() === null || !transport.spotify || !client.serverFeatures()?.includes('spotify_gateway')) return null;
	try {
		const t = await transport.spotify.token({ deviceId: client.deviceId() });
		spotifyToken = { value: t.accessToken, until: t.expiresAt - 60_000 };
		return t.accessToken;
	} catch (e) {
		if (e instanceof CloudTransportError && (e.kind === 'spotify_not_connected' || e.kind === 'spotify_reconnect_required')) return null;
		throw e;
	}
}

let work: PhoneWork | null = null;
function phoneWork(): PhoneWork {
	work ??= createPhoneWork({
		emit: (e) => emit(e),
		offered: () => {
			const { client, transport } = lib();
			return transport.session() !== null && !!transport.catalog && (client.serverFeatures()?.includes('catalog_device_work') ?? false);
		},
		report: (input) => {
			const { client, transport } = lib();
			return transport.catalog!.workReport({ deviceId: client.deviceId(), ...input });
		},
		spotifyToken: gatewayToken,
		fetch: (via) => storeFetch.via(via),
	});
	return work;
}

// A refused sign-in is its code (Kotlin words it); anything else says where.
const failure = (e: unknown): string => (e instanceof AuthError ? e.code : e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));

g['__dispatch'] = (name: string, argJson: string, id: number): void => {
	const fn = CALLS[name];
	const answer = (ok: boolean, value: unknown): void => emit({ type: 'result', id, ok, ...(ok ? { value: value ?? null } : { error: value }) });
	if (!fn) { answer(false, `no call ${name}`); return; }
	try {
		const r = fn(JSON.parse(argJson) as Record<string, unknown>);
		if (r && typeof (r as Promise<unknown>).then === 'function') {
			(r as Promise<unknown>).then((v) => answer(true, v), (e: unknown) => answer(false, failure(e)));
		} else answer(true, r);
	} catch (e) {
		answer(false, failure(e));
	}
};
