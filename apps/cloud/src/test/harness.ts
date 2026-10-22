// Test harness: a migrated PGlite database with the Supabase shim, a locally
// generated signing key served as an in-memory JWKS, and a typed tRPC client
// whose `fetch` is the app's handler. Nothing here opens a socket or talks
// to a network service.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
	keyBetween,
	type CataloguePolicy,
	parseOp,
	SCHEMA_VERSION,
	cueEntityId,
	trackTagEntityId,
	type Entity,
	type KindOf,
	type Op,
	type PayloadOf,
} from '@curator/protocol';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createFetchHandler, type FetchHandler } from '../app.js';
import { AuditWriter } from '../audit.js';
import { createTokenVerifier } from '../auth/jwt.js';
import type { Db, Param, Queryable, Row } from '../db/db.js';
import { findSqlDir, migrate } from '../db/migrate.js';
import { createLogger, type Logger } from '../log.js';
import { TokenBucketLimiter, type RateLimits } from '../rate-limit.js';
import type { AppRouter } from '../router.js';
import { CATALOGUE_POLICY_D_A, parseCataloguePolicy } from '../catalogue/policy.js';
import { DEFAULT_BATCH_OPTIONS, type BatchOptions } from '../sync/batch.js';
import { DEFAULT_PULL_OPTIONS, type PullOptions } from '../sync/pull.js';
import type { AppDeps } from '../trpc.js';
import { SUPABASE_SHIM_SQL } from './supabase-shim.js';

export const SUPABASE_URL = 'https://test-project.supabase.co';
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

// ── database ────────────────────────────────────────────────────────────────

function wrap(q: PGlite | Transaction): Queryable {
	return {
		async query<T extends Row = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
			return (await q.query<T>(text, params as Param[])).rows;
		},
		async exec(text: string): Promise<void> {
			await q.exec(text);
		},
	};
}

export function pgliteDb(pg: PGlite): Db {
	const base = wrap(pg);
	return {
		query: base.query,
		exec: base.exec,
		begin: (fn) => pg.transaction((tx) => fn(wrap(tx))),
		close: () => pg.close(),
	};
}

export type TestDb = {
	pg: PGlite;
	db: Db;
	// A row in the shimmed auth.users, which the op/device FKs point at.
	createUser(): Promise<string>;
};

// The unnumbered setup scripts the owner pastes into the SQL editor.
export const ROLES_SQL = readFileSync(join(findSqlDir(), 'roles.sql'), 'utf8');
export const STORAGE_SQL = readFileSync(join(findSqlDir(), 'storage.sql'), 'utf8');

// `migrate: true` (the default) also runs sql/storage.sql, as the owner does
// right after the migrations.
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
	const pg = await PGlite.create();
	await pg.exec(SUPABASE_SHIM_SQL);
	const db = pgliteDb(pg);
	if (opts.migrate !== false) {
		await migrate(db, findSqlDir());
		await db.exec(STORAGE_SQL);
	}
	return {
		pg,
		db,
		async createUser() {
			const id = randomUUID();
			await pg.query('insert into auth.users (id) values ($1)', [id]);
			return id;
		},
	};
}

// Runs `fn` as `userId` the way withUserTx does, for direct-SQL RLS checks.
export async function asUser<T>(pg: PGlite, userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
	return pg.transaction(async (tx) => {
		await tx.query(`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)`, [
			JSON.stringify({ sub: userId, role: 'authenticated' }),
		]);
		return fn(tx);
	});
}

// The owner's step 4 (README "Database setup"): a catalogue account row.
export async function entitle(pg: PGlite, userId: string, opts: { quotaBytes?: number; entitled?: boolean } = {}): Promise<void> {
	await pg.query(
		`insert into curator.catalogue_account (user_id, entitled, quota_bytes) values ($1, $2, coalesce($3::bigint, 943718400))
		on conflict (user_id) do update set entitled = excluded.entitled, quota_bytes = excluded.quota_bytes`,
		[userId, opts.entitled ?? true, opts.quotaBytes === undefined ? null : String(opts.quotaBytes)],
	);
}

// A device's upload, as the storage service records it: an insert into
// storage.objects as the user, judged by sql/storage.sql's insert policy,
// with the size in `metadata` (the column the API's blob check reads).
export async function uploadBlob(pg: PGlite, userId: string, path: string, size: number, bucket: 'catalogue' | 'snapshots' = 'catalogue'): Promise<void> {
	await asUser(pg, userId, (tx) =>
		tx.query(`insert into storage.objects (bucket_id, name, owner_id, metadata) values ($4, $1, $2, jsonb_build_object('size', $3::bigint))`, [
			path,
			userId,
			String(size),
			bucket,
		]),
	);
}

export async function wakeups(pg: PGlite, userId?: string): Promise<{ topic: string; event: string; payload: { seq: number } }[]> {
	const r = await pg.query<{ topic: string; event: string; payload: { seq: number } }>(
		`select topic, event, payload from realtime.messages ${userId ? 'where topic = $1' : ''} order by id`,
		userId ? [`user:${userId}`] : [],
	);
	return r.rows;
}

// ── keys and tokens ─────────────────────────────────────────────────────────

// `claims`: extra payload claims (e.g. the `email` a real Supabase token
// carries), for proving the server never copies them anywhere.
export type SignOptions = { exp?: number | string; aud?: string; iss?: string; sessionId?: string; sub?: string | null; claims?: Record<string, unknown> };

export type TestKeys = {
	keys: ReturnType<typeof createLocalJWKSet>;
	sign(sub: string, opts?: SignOptions): Promise<string>;
};

// ES256 like the Supabase project's asymmetric signing key.
export async function createKeys(kid = 'test-key'): Promise<TestKeys> {
	const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
	const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
	return {
		keys: createLocalJWKSet({ keys: [jwk] }),
		async sign(sub, opts = {}) {
			const jwt = new SignJWT({ ...opts.claims, role: 'authenticated', session_id: opts.sessionId ?? `session-${sub}` })
				.setProtectedHeader({ alg: 'ES256', kid })
				.setIssuer(opts.iss ?? ISSUER)
				.setAudience(opts.aud ?? 'authenticated')
				.setIssuedAt()
				.setExpirationTime(opts.exp ?? '1h');
			if (opts.sub !== null) jwt.setSubject(opts.sub ?? sub);
			return jwt.sign(privateKey);
		},
	};
}

// ── app ─────────────────────────────────────────────────────────────────────

export type TestApp = TestDb &
	TestKeys & {
		deps: AppDeps;
		// Its timer is off: tests `await app.audit.flush()` before reading
		// curator.request_log / audit_event.
		audit: AuditWriter;
		handler: FetchHandler;
		logs: { level: string; msg: string; [k: string]: unknown }[];
		client(token?: string): ReturnType<typeof createTRPCClient<AppRouter>>;
		// A user with a valid token and a registered device.
		signIn(deviceId?: string): Promise<{ userId: string; token: string; deviceId: string; api: ReturnType<typeof createTRPCClient<AppRouter>> }>;
	};

export async function createTestApp(
	opts: {
		limits?: RateLimits;
		pull?: PullOptions;
		auditDb?: Queryable;
		auditOptions?: { maxBuffered?: number; flushAt?: number };
		// Default: stage D-a, as production runs it. `null` = catalogue off.
		catalogue?: CataloguePolicy | null;
		// Default false, as production runs during the 'device_reads' transition.
		requireDeviceId?: boolean;
		// Default: production's, except that batchCommit waits for its commit
		// to finish (a minute), so a test reads `committed` from one call.
		batch?: Partial<BatchOptions>;
	} = {},
): Promise<TestApp> {
	const tdb = await createTestDb();
	const keys = await createKeys();
	const logs: TestApp['logs'] = [];
	const log: Logger = createLogger((line) => logs.push(JSON.parse(line) as TestApp['logs'][number]));
	const audit = new AuditWriter({ db: opts.auditDb ?? tdb.db, log, ...opts.auditOptions });
	const deps: AppDeps = {
		db: tdb.db,
		log,
		auth: createTokenVerifier({ supabaseUrl: SUPABASE_URL, keys: keys.keys }),
		// Generous by default so suites that are not about rate limits never
		// trip them; the rate-limit test injects its own clock and buckets.
		limits: opts.limits ?? defaultRateLimitsUnbounded(),
		pull: opts.pull ?? DEFAULT_PULL_OPTIONS,
		audit,
		catalogue: opts.catalogue === undefined ? parseCataloguePolicy(CATALOGUE_POLICY_D_A) : opts.catalogue,
		requireDeviceId: opts.requireDeviceId ?? false,
		batch: { ...DEFAULT_BATCH_OPTIONS, commitWaitMs: 60_000, ...opts.batch },
	};
	const handler = createFetchHandler(deps);
	const client = (token?: string) =>
		createTRPCClient<AppRouter>({
			links: [
				httpLink({
					url: 'http://cloud.test/trpc',
					fetch: (url, init) => handler(new Request(url as string, init as RequestInit)),
					headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
				}),
			],
		});
	return {
		...tdb,
		...keys,
		deps,
		audit,
		handler,
		logs,
		client,
		async signIn(deviceId = `device-${randomUUID()}`) {
			const userId = await tdb.createUser();
			const token = await keys.sign(userId);
			const api = client(token);
			await api.account.registerDevice.mutate({ deviceId, name: 'Test desktop', platform: 'win32' });
			return { userId, token, deviceId, api };
		},
	};
}

function defaultRateLimitsUnbounded(): RateLimits {
	return { push: new TokenBucketLimiter(1e9, 1e9), pull: new TokenBucketLimiter(1e9, 1e9), catalogue: new TokenBucketLimiter(1e9, 1e9) };
}

// The `reason` the server put in the error's data, for `expect(...).rejects`.
export async function errorReason(p: Promise<unknown>): Promise<{ code: string; reason: string | null; retryAfterSec: number | null }> {
	try {
		await p;
	} catch (e) {
		if (e instanceof TRPCClientError) {
			const data = e.data as { code: string; reason: string | null; retryAfterSec: number | null };
			return { code: data.code, reason: data.reason, retryAfterSec: data.retryAfterSec };
		}
		throw e;
	}
	throw new Error('expected the call to fail');
}

// ── ops ─────────────────────────────────────────────────────────────────────

// An op factory for one device. Stamps start an hour in the past so nothing
// is clamped unless a test means it, and increase by 1 ms per op.
export function opsFor(deviceId: string, start = Date.now() - 3600_000) {
	let ts = start;
	return function op<E extends Entity, K extends KindOf<E>>(entity: E, kind: K, entityId: string, payload: PayloadOf<E, K>, at?: number): Op {
		return parseOp({
			op_id: randomUUID(),
			device_id: deviceId,
			client_ts: at ?? ts++,
			schema_version: SCHEMA_VERSION,
			entity,
			entity_id: entityId,
			kind,
			payload,
		});
	};
}

// A small library touching every reducer path that matters for snapshots:
// container create/rename/delete, add-wins sets with removes, ordered
// membership with a move, LWW fields, whole-cue LWW, a recording merge with
// ops addressed to the loser, append-only plays and a setting.
export function sampleLibrary(deviceId: string, n = 1): Op[] {
	const op = opsFor(deviceId);
	const out: Op[] = [];
	for (let i = 0; i < n; i++) {
		const tag = randomUUID();
		const deadTag = randomUUID();
		const playlist = randomUUID();
		const recs = [randomUUID(), randomUUID(), randomUUID()];
		const [r0, r1, r2] = recs as [string, string, string];
		const rows = [randomUUID(), randomUUID(), randomUUID()];
		const k0 = keyBetween(null, null);
		const k1 = keyBetween(k0, null);
		const k2 = keyBetween(k1, null);
		const session = randomUUID();
		for (const r of recs) out.push(op('library_track', 'create', r, { added_at: Date.now() - 7200_000 }));
		out.push(
			op('tag', 'create', tag, { name: `tag ${i}`, kind: 'user', color: null }),
			op('tag', 'rename', tag, { name: `renamed ${i}` }),
			op('tag', 'create', deadTag, { name: 'doomed', kind: 'user' }),
			op('track_tag', 'add', trackTagEntityId(r0, tag), {}),
			op('track_tag', 'add', trackTagEntityId(r1, tag), {}),
			op('track_tag', 'remove', trackTagEntityId(r1, tag), {}),
			op('track_tag', 'add', trackTagEntityId(r2, deadTag), {}),
			op('tag', 'delete', deadTag, {}),
			op('playlist', 'create', playlist, { name: `set ${i}`, folder_id: null }),
			op('playlist_track', 'add', rows[0]!, { playlist_id: playlist, recording_id: r0, order_key: k0 }),
			op('playlist_track', 'add', rows[1]!, { playlist_id: playlist, recording_id: r1, order_key: k1 }),
			op('playlist_track', 'add', rows[2]!, { playlist_id: playlist, recording_id: r2, order_key: k2 }),
			op('playlist_track', 'move', rows[2]!, { order_key: keyBetween(null, k0) }),
			op('playlist_track', 'remove', rows[1]!, {}),
			op('library_track', 'set-rating', r0, { rating: 4 }),
			op('library_track', 'set-rating', r0, { rating: 5 }),
			op('library_track', 'set-override', r1, { field: 'title', value: `Title ${i}` }),
			op('cue', 'upsert', cueEntityId(r0, 1, 'hot'), { slot: 1, kind: 'hot', position_sec: 12.5, length_sec: null, color: '#ff0000', name: 'drop' }),
			op('cue', 'upsert', cueEntityId(r0, 1, 'hot'), { slot: 1, kind: 'hot', position_sec: 13, length_sec: null, color: null, name: 'drop 2' }),
			op('cue', 'upsert', cueEntityId(r2, 2, 'memory'), { slot: 2, kind: 'memory', position_sec: 3, length_sec: 4, color: null, name: null }),
			op('recording', 'merge', r2, { winner: r1 }),
			op('library_track', 'set-rating', r2, { rating: 3 }),
			op('play_session', 'append', session, {
				origin: 'curator',
				kind: 'prep',
				kind_source: 'auto',
				name: null,
				started_at: Date.now() - 5000_000,
				ended_at: null,
				rb_history_id: null,
			}),
			op('setting', 'set', 'credit_format', { value: i % 2 === 0 ? 'short' : 'long' }),
			// Protocol v2: curation state (one on the merge loser, redirected)
			// and an artist alias chain with a withdrawn rule.
			op('library_track', 'set-state', r0, { state: 'backlog' }),
			op('library_track', 'set-state', r2, { state: 'progress' }),
			op('artist_alias', 'set', `a${i}`, { from: `A${i}`, to: `B${i}`, to_key: `b${i}` }),
			op('artist_alias', 'set', `b${i}`, { from: `B${i}`, to: `C${i}`, to_key: `c${i}` }),
			op('artist_alias', 'set', `x${i}`, { from: `X${i}`, to: `Y${i}`, to_key: `y${i}` }),
			op('artist_alias', 'remove', `x${i}`, {}),
		);
	}
	return out;
}
