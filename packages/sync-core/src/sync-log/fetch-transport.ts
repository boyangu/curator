// The sync client's CloudTransport over plain HTTP requests, for a host that
// is not the desktop: a phone's sync core (the client inside an embedded JS
// engine), a headless tool. The desktop has its own (apps/desktop main/
// cloud/transport.ts: Electron's network stack, the tRPC client, request
// logging); this one needs nothing but "send this request, give me the
// answer" from its host, so it runs where there is no fetch, no URL class
// and no tRPC client to load.
//
// It speaks the API's wire format directly — tRPC over HTTP, unbatched, no
// transformer (apps/cloud src/app.ts): a query is `GET /trpc/<path>?input=
// <json>`, a mutation `POST /trpc/<path>` with the input as its JSON body;
// the answer is `{ result: { data } }` or `{ error: { message, data: {
// httpStatus, reason, retryAfterSec } } }`. Refusals become the same
// CloudTransportError kinds the desktop's transport maps them to (the
// server's `reason` is the contract), since the client branches on those.
//
// What stays the host's: who is signed in and the bearer token (sign-in and
// refresh are a platform matter), the bytes of the `snapshots` bucket, and
// inflating a snapshot body (snapshot-storage.ts inflateSnapshotText on
// Node; a phone's own inflater). The bootstrap itself — manifest, parts
// checked against it, text handed over in pieces — is the shared code.
//
// Covered: sync and account, which is what a device needs to hold the
// library, and the analysis catalogue's procedures (a phone reads waveform
// peaks through `catalogue.lookup`; catalogue/peaks.ts), the Global Catalog
// and its event stream (feed/device-feed.ts). The Spotify gateway is an
// optional member of CloudTransport and is not here yet.

import { randomUUID } from 'node:crypto';
import {
	CALL_ERROR_REASONS,
	type BatchAbortInput,
	type BatchAbortResult,
	type BatchBeginInput,
	type BatchBeginResult,
	type BatchCommitInput,
	type BatchCommitResult,
	type BatchPushInput,
	type BatchPushResult,
	type BootstrapInput,
	type BootstrapResult,
	type CallErrorReason,
	type CatalogBrowseInput,
	type CatalogBrowseResult,
	type CatalogConnectAnswerInput,
	type CatalogConnectAnswerResult,
	type CatalogConnectQueueInput,
	type CatalogConnectQueueResult,
	type CatalogConnectSearchInput,
	type CatalogConnectSearchResult,
	type CatalogEnrichInput,
	type CatalogEnrichResult,
	type CatalogGetInput,
	type CatalogImportInput,
	type CatalogImportResult,
	type CatalogIngestInput,
	type CatalogIngestResult,
	type CatalogListWatchesInput,
	type CatalogMuteInput,
	type CatalogObjectDetail,
	type CatalogRefreshInput,
	type CatalogRefreshResult,
	type CatalogResolveInput,
	type CatalogResolveResult,
	type CatalogSearchInput,
	type CatalogSearchResult,
	type CatalogTracksInput,
	type CatalogTracksResult,
	type CatalogUnwatchInput,
	type CatalogWatch,
	type CatalogWatchInput,
	type CatalogWatchResult,
	type CatalogWorkerDueInput,
	type CatalogWorkerDueResult,
	type CatalogWorkerReportInput,
	type CatalogWorkerReportResult,
	type CatalogueInventoryInput,
	type CatalogueInventoryResult,
	type CatalogueLookupInput,
	type CatalogueLookupResult,
	type CataloguePutInput,
	type CataloguePutResult,
	type DeviceInfo,
	type FeedEventsInput,
	type FeedEventsResult,
	type FeedRecentInput,
	type FeedRecentResult,
	type PublishReplicaInput,
	type PublishReplicaResult,
	type PublishSnapshotInput,
	type PublishSnapshotResult,
	type PullInput,
	type PullResult,
	type PushInput,
	type PushResult,
	type RegisterDeviceInput,
} from '@curator/protocol';
import { CloudTransportError, type CloudSession, type CloudTransport } from './client.js';
import type { SnapshotText } from './snapshot.js';
import { readStorageSnapshotBody, type SnapshotBlobStore } from './snapshot-storage.js';

export type HttpRequest = { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string };
export type HttpResponse = { status: number; body: string };

export type FetchTransportDeps = {
	// The API's origin, no trailing slash: tRPC is served under `/trpc`.
	apiUrl: string;
	// One request, one answer, whatever its status. Rejects only when no
	// answer came (offline, a timeout): that is reported as `network`.
	// Compression is the platform HTTP's: it should ask for gzipped answers
	// and hand back the inflated body (OkHttp and URLSession do), and may gzip
	// a large body once the server's answers carry `Accept-Encoding: gzip`
	// (apps/cloud http.ts).
	request(req: HttpRequest): Promise<HttpResponse>;
	// Who is signed in, or null; and the bearer token for the next call
	// (refreshed by the host when it must be).
	session(): CloudSession | null;
	// `refresh`: the last one was refused, so have a new one made.
	accessToken(opts?: { refresh?: boolean }): Promise<string | null>;
	// Ends this install's session only (the sync client's unlink).
	signOut(): Promise<void>;
	// The `snapshots` bucket as the signed-in user; and whether a failed
	// download says the object is no longer there (a newer snapshot replaced
	// the one being read), as the host's store reports that.
	snapshots: SnapshotBlobStore;
	partGone?(err: unknown): boolean;
	// A checked gzip body as its JSON text in pieces, at most `maxBytes` of it.
	inflate(body: Uint8Array, opts: { maxBytes: number }): SnapshotText;
	// `x-curator-client`, e.g. `android/0.4.0`: lets the server's log tell
	// one release from another.
	client: string;
};

// What a corrupt snapshot body may inflate to, as the desktop caps it.
const MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

type ErrorData = { httpStatus?: unknown; reason?: unknown; retryAfterSec?: unknown };
type Answer = { result?: { data?: unknown }; error?: { message?: unknown; data?: ErrorData } };

function asReason(v: unknown): CallErrorReason | 'update_required' | null {
	if (typeof v !== 'string') return null;
	if (v === 'update_required') return v;
	return (CALL_ERROR_REASONS as readonly string[]).includes(v) ? (v as CallErrorReason) : null;
}

// The desktop transport's mapping, from the same facts: the HTTP status and
// the server's stable `reason` (its error message carries the same string).
export function cloudErrorOf(status: number, error: { message?: unknown; data?: ErrorData } | undefined): CloudTransportError {
	const data = error?.data ?? {};
	const http = typeof data.httpStatus === 'number' ? data.httpStatus : status;
	const reason = asReason(data.reason) ?? asReason(error?.message);
	const retryMs = typeof data.retryAfterSec === 'number' ? data.retryAfterSec * 1000 : undefined;
	if (reason === 'update_required') return new CloudTransportError('update_required', reason);
	if (reason === 'device_revoked') return new CloudTransportError('device_revoked', reason);
	if (reason === 'device_not_registered') return new CloudTransportError('device_not_registered', reason);
	if (reason === 'rate_limited' || http === 429) return new CloudTransportError('rate_limited', reason ?? 'rate limited', retryMs);
	// The server is older than this client's ops: retry later, the ops stay pending.
	if (reason === 'server_outdated') return new CloudTransportError('server', reason, retryMs);
	if (reason === 'batch_gone') return new CloudTransportError('batch_gone', reason);
	if (reason === 'batch_committing') return new CloudTransportError('batch_committing', reason);
	if (reason === 'not_master' || reason === 'snapshot_ahead' || reason === 'snapshot_part_missing' || reason === 'snapshot_part_invalid' || reason === 'replica_without_snapshot') return new CloudTransportError(reason, reason);
	if (reason === 'spotify_not_connected' || reason === 'spotify_reconnect_required') return new CloudTransportError(reason, reason);
	if (reason === 'catalog_disabled' || reason === 'catalog_not_found' || reason === 'catalog_watch_limit' || reason === 'catalog_claim_invalid') return new CloudTransportError(reason, reason);
	if (http === 401 || reason === 'missing_token' || reason === 'token_expired' || reason === 'invalid_token') return new CloudTransportError('auth', reason ?? 'unauthorized');
	if (http >= 500) return new CloudTransportError('server', `HTTP ${http}`);
	if (http >= 400) return new CloudTransportError('bad_request', reason ?? `HTTP ${http}`);
	return new CloudTransportError('server', `HTTP ${http}: an answer that is neither a result nor an error`);
}

export function createFetchCloudTransport(deps: FetchTransportDeps): CloudTransport {
	const attempt = async <T>(type: 'query' | 'mutation', path: string, input: unknown, token: string | null): Promise<T> => {
		const headers: Record<string, string> = {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			'x-request-id': randomUUID(),
			'x-curator-client': deps.client,
		};
		const url = `${deps.apiUrl}/trpc/${path}`;
		let res: HttpResponse;
		try {
			res = type === 'query'
				? await deps.request({ method: 'GET', url: input === undefined ? url : `${url}?input=${encodeURIComponent(JSON.stringify(input))}`, headers })
				: await deps.request({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
		} catch (err) {
			if (err instanceof CloudTransportError) throw err;
			throw new CloudTransportError('network', err instanceof Error ? err.message : String(err));
		}
		let answer: Answer | null = null;
		try { answer = JSON.parse(res.body) as Answer; } catch { /* a proxy's page, an empty body: judged by the status below */ }
		if (answer && typeof answer === 'object' && answer.result && res.status >= 200 && res.status < 300) return answer.result.data as T;
		throw cloudErrorOf(res.status, answer && typeof answer === 'object' ? answer.error : undefined);
	};
	const call = async <T>(type: 'query' | 'mutation', path: string, input?: unknown): Promise<T> => {
		// No session: fail as auth instead of a guaranteed 401 round trip.
		if (!deps.session()) throw new CloudTransportError('auth', 'signed out');
		const token = await deps.accessToken();
		try {
			return await attempt<T>(type, path, input, token);
		} catch (err) {
			// A token retired before this device expected it (its clock was
			// changed, say): once more with a fresh one. A refusal is answered
			// before anything runs, so asking again repeats nothing.
			if (!(err instanceof CloudTransportError) || err.kind !== 'auth' || !token) throw err;
			const fresh = await deps.accessToken({ refresh: true });
			if (!fresh || fresh === token) throw err;
			return attempt<T>(type, path, input, fresh);
		}
	};

	return {
		session: () => deps.session(),
		signOut: () => deps.signOut(),
		sync: {
			push: (input: PushInput) => call<PushResult>('mutation', 'sync.push', input),
			pull: (input: PullInput) => call<PullResult>('query', 'sync.pull', input),
			batchBegin: (input: BatchBeginInput) => call<BatchBeginResult>('mutation', 'sync.batchBegin', input),
			batchPush: (input: BatchPushInput) => call<BatchPushResult>('mutation', 'sync.batchPush', input),
			batchCommit: (input: BatchCommitInput) => call<BatchCommitResult>('mutation', 'sync.batchCommit', input),
			batchAbort: (input: BatchAbortInput) => call<BatchAbortResult>('mutation', 'sync.batchAbort', input),
			publishSnapshot: (input: PublishSnapshotInput) => call<PublishSnapshotResult>('mutation', 'sync.publishSnapshot', input),
			publishReplica: (input: PublishReplicaInput) => call<PublishReplicaResult>('mutation', 'sync.publishReplica', input),
		},
		snapshots: deps.snapshots,
		// The bootstrap answer's replica alone ('replica_storage'), asked
		// before this device has a library or an id. A server from before the
		// feature refuses the unknown key as a bad request: no replica then.
		async replica(schema: number) {
			try {
				return (await call<BootstrapResult>('query', 'sync.bootstrap', { storage: true, replicaSchema: schema })).replica ?? null;
			} catch (err) {
				if (err instanceof CloudTransportError && err.kind === 'bad_request') return null;
				throw err;
			}
		},
		// As the desktop's: always `storage: true` (a server that holds no
		// other kind refuses a call without it); the manifest's parts are read
		// from the bucket and checked against it before anything inflates, and
		// the text is handed over in pieces (snapshot.ts loadSnapshotText). A
		// part pruned meanwhile — a newer snapshot replaced it mid-read —
		// starts over from the newer one, a few times at most.
		async bootstrap(input?: BootstrapInput) {
			for (let attempt = 0; ; attempt++) {
				const res = await call<BootstrapResult>('query', 'sync.bootstrap', { ...(input ?? {}), storage: true });
				if (!res.storage) return { snapshotSeq: res.snapshotSeq, baseSeq: res.baseSeq, snapshot: null };
				let body: Uint8Array;
				try {
					body = await readStorageSnapshotBody(res.storage, (path) => deps.snapshots.download(path), { maxBytes: MAX_INFLATED_BYTES });
				} catch (err) {
					if (deps.partGone?.(err) && attempt < 3) continue;
					throw err;
				}
				return { snapshotSeq: res.snapshotSeq, baseSeq: res.baseSeq, snapshot: deps.inflate(body, { maxBytes: MAX_INFLATED_BYTES }) };
			}
		},
		catalogue: {
			lookup: (input: CatalogueLookupInput) => call<CatalogueLookupResult>('mutation', 'catalogue.lookup', input),
			put: (input: CataloguePutInput) => call<CataloguePutResult>('mutation', 'catalogue.put', input),
			inventory: (input: CatalogueInventoryInput) => call<CatalogueInventoryResult>('query', 'catalogue.inventory', input),
		},
		// 'global_catalog' and the features after it: used only once the server
		// lists them.
		catalog: {
			ingest: (input: CatalogIngestInput) => call<CatalogIngestResult>('mutation', 'catalog.ingest', input),
			resolve: (input: CatalogResolveInput) => call<CatalogResolveResult>('mutation', 'catalog.resolve', input),
			search: (input: CatalogSearchInput) => call<CatalogSearchResult>('mutation', 'catalog.search', input),
			get: (input: CatalogGetInput) => call<CatalogObjectDetail>('query', 'catalog.get', input),
			browse: (input: CatalogBrowseInput) => call<CatalogBrowseResult>('query', 'catalog.browse', input),
			watch: (input: CatalogWatchInput) => call<CatalogWatchResult>('mutation', 'catalog.watch', input),
			unwatch: (input: CatalogUnwatchInput) => call<{ ok: true }>('mutation', 'catalog.unwatch', input),
			mute: (input: CatalogMuteInput) => call<{ ok: true }>('mutation', 'catalog.mute', input),
			listWatches: (input: CatalogListWatchesInput) => call<CatalogWatch[]>('query', 'catalog.listWatches', input),
			import: (input: CatalogImportInput) => call<CatalogImportResult>('mutation', 'catalog.import', input),
			refreshNow: (input: CatalogRefreshInput) => call<CatalogRefreshResult>('mutation', 'catalog.refreshNow', input),
			enrich: (input: CatalogEnrichInput) => call<CatalogEnrichResult>('mutation', 'catalog.enrich', input),
			workerDue: (input: CatalogWorkerDueInput) => call<CatalogWorkerDueResult>('mutation', 'catalog.workerDue', input),
			workerReport: (input: CatalogWorkerReportInput) => call<CatalogWorkerReportResult>('mutation', 'catalog.workerReport', input),
			connectQueue: (input: CatalogConnectQueueInput) => call<CatalogConnectQueueResult>('mutation', 'catalog.connectQueue', input),
			connectAnswer: (input: CatalogConnectAnswerInput) => call<CatalogConnectAnswerResult>('mutation', 'catalog.connectAnswer', input),
			connectSearch: (input: CatalogConnectSearchInput) => call<CatalogConnectSearchResult>('mutation', 'catalog.connectSearch', input),
			tracks: (input: CatalogTracksInput) => call<CatalogTracksResult>('query', 'catalog.tracks', input),
		},
		feed: {
			events: (input: FeedEventsInput) => call<FeedEventsResult>('query', 'feed.events', input),
			recent: (input: FeedRecentInput) => call<FeedRecentResult>('query', 'feed.recent', input),
		},
		account: {
			registerDevice: (input: RegisterDeviceInput) => call<{ ok: true }>('mutation', 'account.registerDevice', input),
			devices: () => call<DeviceInfo[]>('query', 'account.devices'),
			revokeDevice: (input: { deviceId: string }) => call<{ ok: true }>('mutation', 'account.revokeDevice', input),
		},
	};
}
