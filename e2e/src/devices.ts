// One desktop of the run: a real CoreService on a work-dir database, signed
// in to the local cloud, plus a raw handle on the same file for the run's own
// reads and the few writes no service method covers. Mirrors core's
// two-desktop rig (test-support/two-desktops.ts): no remoteWritePolicy, every
// streaming adapter a recorder that throws, the OS trash refused, no
// analyzer, audio or mir sidecar. The rekordbox sidecar only where a step
// needs it, always with its write guard.

import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createCoreService, createDb, inlineSnapshotBuilder, type CoreService, type CoreServiceOptions } from '@curator/core';
import { readCursor, SNAPSHOT_PUBLISH_REQUEST_KEY } from '@curator/core/e2e';
import { getSourceCapabilities, type StreamingSource } from '@curator/shared';
import type { Logger } from '@curator/shared/log';
import type { LocalCloud, HarnessTransport } from './cloud.js';
import type { SidecarSpec } from './rekordbox.js';

type Raw = Database.Database;

function refusingAdapter(source: StreamingSource, calls: string[]): NonNullable<CoreServiceOptions['sourceAdapters']>[StreamingSource] {
	const hit = (m: string) => async (): Promise<never> => {
		calls.push(`${source}.${m}`);
		throw new Error(`e2e: streaming adapter ${source}.${m} refused`);
	};
	return {
		source,
		displayName: `e2e ${source}`,
		capabilities: getSourceCapabilities(source),
		listRemotePlaylists: hit('listRemotePlaylists'),
		fetchPlaylistTracks: hit('fetchPlaylistTracks'),
		createPlaylist: hit('createPlaylist'),
		deletePlaylist: hit('deletePlaylist'),
		renamePlaylist: hit('renamePlaylist'),
		addTracks: hit('addTracks'),
		removeTracks: hit('removeTracks'),
		replaceTracks: hit('replaceTracks'),
		reorderTracks: hit('reorderTracks'),
	};
}

export type Device = {
	name: string;
	dir: string;
	dbPath: string;
	svc: CoreService;
	raw: Raw;
	transport: HarnessTransport;
	// Streaming adapter calls (must stay empty) and write-audit entries (the
	// rekordbox write batches land here).
	upstream: string[];
	audit: Array<Record<string, unknown>>;
	close(): Promise<void>;
};

export function openDevice(opts: { name: string; dir: string; dbPath: string; transport: HarnessTransport; logger: Logger; rekordbox?: SidecarSpec }): Device {
	const upstream: string[] = [];
	const audit: Array<Record<string, unknown>> = [];
	const svc = createCoreService(opts.dbPath, {
		logger: opts.logger,
		peaksDir: join(opts.dir, 'peaks'),
		sourceAdapters: { spotify: refusingAdapter('spotify', upstream), tidal: refusingAdapter('tidal', upstream) },
		writeAudit: (e) => { audit.push(e); },
		trashFile: async (p) => { throw new Error(`e2e: refused to trash ${p}`); },
		cloud: {
			transport: opts.transport,
			device: { name: `e2e ${opts.name}`, platform: process.platform === 'darwin' ? 'darwin' : 'win32' },
			// Parts are built under the work dir, not the OS temp dir.
			snapshot: { builder: inlineSnapshotBuilder(opts.dbPath, join(opts.dir, 'tmp')) },
		},
		...(opts.rekordbox ? { rekordbox: opts.rekordbox } : {}),
	});
	const { sqlite } = createDb(opts.dbPath);
	return {
		name: opts.name, dir: opts.dir, dbPath: opts.dbPath, svc, raw: sqlite, transport: opts.transport, upstream, audit,
		async close() {
			try { svc.close(); } catch { /* already closed */ }
			// The sidecar's shutdown and the scanner's watchers finish async;
			// svc.close() does not wait for them. The rekordbox sidecar may take
			// its whole 2 s grace (RekordboxSidecar.shutdown) before it lets go
			// of its read snapshot under the work dir's tmp/.
			await new Promise((r) => setTimeout(r, opts.rekordbox ? 2_500 : 200));
			try { sqlite.close(); } catch { /* */ }
		},
	};
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The master's publish and a secondary's digest check run beside a cycle
// (client.ts): wait them out so the next step sees what they did.
async function publishIdle(d: Device, deadline: number, label: string): Promise<void> {
	for (;;) {
		const s = (await d.svc.getCloudSyncStatus()).snapshot;
		if (!s.publishing && !s.verifying) return;
		if (Date.now() > deadline) throw new Error(`${label}: ${d.name}'s snapshot publish or digest check still running at the deadline`);
		await tick(50);
	}
}

export type SettleOptions = {
	timeoutMs: number;
	// A device-specific reason it is not done yet (null: done).
	pending?: (d: Device) => string | null | Promise<string | null>;
	onRound?: (round: number, blockers: string[]) => void;
};

// Sync the devices round after round until one moves nothing: no op reached
// the cloud, no snapshot was published, and every device has its cursor at
// the head, nothing pending, no error, no phase it waits in — and whatever
// `pending` adds. Throws with every device's status at the deadline.
export async function settle(cloud: LocalCloud, userId: string, devices: readonly Device[], label: string, opts: SettleOptions): Promise<number> {
	const deadline = Date.now() + opts.timeoutMs;
	for (let round = 1; ; round++) {
		const head0 = await cloud.head(userId);
		const snap0 = await cloud.latestSnapshot(userId);
		for (const d of devices) {
			await d.svc.cloudSyncNow();
			await publishIdle(d, deadline, label);
		}
		const head = await cloud.head(userId);
		const snap = await cloud.latestSnapshot(userId);
		const blockers: string[] = [];
		if (head !== head0) blockers.push(`head moved ${head0} → ${head}`);
		if (snap?.seq !== snap0?.seq) blockers.push(`snapshot published at ${snap?.seq}`);
		for (const d of devices) {
			const s = await d.svc.getCloudSyncStatus();
			const cursor = readCursor(d.raw).lastSeq;
			if (!s.initialPushDone) blockers.push(`${d.name}: library not stated yet`);
			if (s.pending > 0) blockers.push(`${d.name}: ${s.pending} ops pending`);
			if (s.lastError) blockers.push(`${d.name}: ${s.lastError}`);
			if (s.phase) blockers.push(`${d.name}: ${s.phase}`);
			if (cursor < head) blockers.push(`${d.name}: cursor ${cursor} < head ${head}`);
			const more = await opts.pending?.(d);
			if (more) blockers.push(`${d.name}: ${more}`);
		}
		opts.onRound?.(round, blockers);
		if (blockers.length === 0) return round;
		if (Date.now() > deadline) {
			const states = await Promise.all(devices.map(async (d) => ({ name: d.name, status: await d.svc.getCloudSyncStatus() })));
			throw new Error(`${label}: not settled after ${round} rounds (${blockers.join('; ')}). Status: ${JSON.stringify(states)}`);
		}
		await tick(100);
	}
}

// The founder is done once its base is up and nothing it asked to publish
// is still owed (the analysis backfill's republish: client.ts
// SNAPSHOT_PUBLISH_REQUEST_KEY).
export function founderPending(cloud: LocalCloud, userId: string): (d: Device) => Promise<string | null> {
	return async (d) => {
		if (!(await cloud.latestSnapshot(userId))) return 'no snapshot published yet';
		const owed = d.raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(SNAPSHOT_PUBLISH_REQUEST_KEY) as string | undefined;
		return owed ? `publish requested (${owed})` : null;
	};
}

// A joiner is done once its remote rows and their derivations are drained.
export function joinerPending(d: Device): string | null {
	const n = (t: string): number => {
		try { return d.raw.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number; } catch { return 0; }
	};
	const remote = n('track_remote_pending');
	const derive = n('track_derive_pending');
	return remote + derive > 0 ? `${remote} remote rows and ${derive} derivations queued` : null;
}
