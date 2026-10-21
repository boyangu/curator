// The catalogue layer's public shapes and its two ports. Protocol types
// (items, policy, results) come from @curator/protocol; what is here is the
// device's side: its settings, its status, and what the host injects.

import type { CataloguePolicy, CloudService } from '@curator/protocol';
import type { CloudSession } from '../sync-log/client.js';

// The `catalogue.*` procedures and who is signed in. The desktop's HTTP
// transport (apps/desktop/src/main/cloud/transport.ts) provides both; tests
// inject an in-memory server.
export interface CatalogueTransport {
	catalogue: CloudService['catalogue'];
	session(): CloudSession | null;
}

// Objects in the `catalogue` Storage bucket, moved by the device itself with
// its own session (never through the API). Paths are exactly
// `catalogueBlobPath(...)`. Objects are immutable and content-addressed, so
// `upload` of a path that already exists is success, not an error.
export interface CatalogueBlobStore {
	upload(path: string, bytes: Uint8Array): Promise<void>;
	download(path: string): Promise<Uint8Array>;
	remove(paths: string[]): Promise<void>;
}

// Thrown by a blob store for a refusal that will not change on retry
// (403 from the bucket policy: not entitled, over quota, wrong prefix).
export class CatalogueBlobError extends Error {
	override readonly name = 'CatalogueBlobError';
	constructor(readonly kind: 'denied' | 'not_found' | 'too_large' | 'transient', message: string) {
		super(message);
	}
}

// Device-local (app_setting `catalogue.settings`, never synced):
//   enabled  reuse and share analysis with this account's other devices
//            (lookups, hydration, uploading what this device analyses)
//   vectors  include AI vectors once the server allows them (stage D-b)
//   backfill the "upload existing analysis" run, started only from the
//            button: off → running ⇄ paused → done
//   maxKBps  upload throttle for blobs
export type CatalogueBackfillState = 'off' | 'running' | 'paused' | 'done';
export type CatalogueSettings = {
	enabled: boolean;
	vectors: boolean;
	backfill: CatalogueBackfillState;
	maxKBps: number;
};
export type CatalogueSettingsPatch = Partial<Pick<CatalogueSettings, 'enabled' | 'vectors' | 'maxKBps'>>;
export type CatalogueBackfillAction = 'start' | 'pause' | 'resume' | 'stop';

export const DEFAULT_CATALOGUE_SETTINGS: CatalogueSettings = {
	enabled: true,
	vectors: true,
	backfill: 'off',
	maxKBps: 2048,
};
export const CATALOGUE_KBPS_LIMITS: readonly [number, number] = [64, 102_400];

export type CatalogueStatus = {
	// The build has a cloud transport and a blob store (else: neutral values).
	available: boolean;
	settings: CatalogueSettings;
	signedIn: boolean;
	// Whether the server lists 'catalogue' in its features; null = not known
	// yet (no sync answer this session).
	serverOffers: boolean | null;
	// What the server accepts (the D-a / D-b stage), from the last inventory.
	policy: CataloguePolicy | null;
	entitled: boolean | null;
	usage: { usedBytes: number; quotaBytes: number } | null;
	// The account's holdings as this device's mirror knows them.
	account: { items: number; bytes: number };
	device: {
		// Units this device took from the catalogue instead of computing.
		reused: number;
		// Units this device put.
		uploaded: number;
		// This device's analysis the account does not hold yet: what the
		// backfill button would upload. Null until first estimated.
		pending: { items: number; bytes: number } | null;
	};
	backfill: {
		state: CatalogueBackfillState;
		// This session's run.
		uploadedItems: number;
		uploadedBytes: number;
		// Why a running backfill is idle right now, e.g. 'audio analysis'.
		waitingFor: string | null;
	};
	activity: 'inventory' | 'hydrating' | 'uploading' | null;
	lastHydrateAt: number | null;
	lastUploadAt: number | null;
	// The last completed check with the server, whether or not anything moved.
	lastCheckedAt: number | null;
	lastError: string | null;
	nextRetryAt: number | null;
};

export type CatalogueEvent =
	| { kind: 'status'; status: CatalogueStatus }
	// Tracks whose analysis (or lo waveform) was filled in from the catalogue
	// outside an analysis job: the track list refreshes these rows.
	| { kind: 'hydrated'; trackIds: string[] };
