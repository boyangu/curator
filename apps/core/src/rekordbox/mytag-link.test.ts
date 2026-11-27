// Curator-made tags reaching rekordbox (mytag-phase.ts) and coming back on
// the pull (tag-link.ts). The push gives each user tag on an rb-linked track a
// DjmdMyTag in its own write session, links it, and the update push then
// treats it as an rb tag; the pull lands the MyTag on the linked Curator tag
// instead of minting an `rb_` twin. Real exporter/importer against a migrated
// temp DB, stub sidecar standing in for master.db.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '@curator/sync-core/db/migrate';
import { createDb, type Db } from '@curator/sync-core/db/client';
import { RekordboxExporter, type ExportFlags } from './exporter.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import type { MyTagEnsureOp, RekordboxSidecar, WriteOp, WriteOpResult } from './sidecar.js';
import { DEFAULT_MYTAG_GROUP_NAME, pickMyTagGroup, type MyTagGroupChoice } from './mytag-phase.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-mytaglink-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

// pushedAt 2000 > updatedAt 1000: already pushed, so "Sync updates" would not
// select the track on its own — the bluerama case (tagged, then synced).
function seedLinkedTrack(id: string, rbContentId: string, comment: string | null = null): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, comment, updated_at) VALUES (?, ?, '[]', 'unsorted', ?, 1000)`).run(id, id, comment);
	sqlite.prepare(
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, pushed_at) VALUES (?, ?, 0, 0, 0, 2000)`,
	).run(id, rbContentId);
}
function seedUnlinkedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES (?, ?, '[]', 'unsorted', 1000)`).run(id, id);
}
// added_at strictly increasing: the comment block lists tags in assignment order.
let assignedAt = 1;
function tag(trackId: string, tagId: string, name: string, kind: 'user' | 'system' = 'user'): void {
	sqlite.prepare(`INSERT OR IGNORE INTO tag (id, name, kind) VALUES (?, ?, ?)`).run(tagId, name, kind);
	sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, ?)`).run(trackId, tagId, assignedAt++);
}
const links = (): Array<{ tag_id: string; rb_tag_id: string }> =>
	sqlite.prepare(`SELECT tag_id, rb_tag_id FROM rekordbox_tag_link ORDER BY tag_id`).all() as Array<{ tag_id: string; rb_tag_id: string }>;
const tagIds = (): string[] => (sqlite.prepare(`SELECT id FROM tag WHERE kind = 'user' ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
const membersOf = (tagId: string): string[] =>
	(sqlite.prepare(`SELECT track_id FROM track_tag WHERE tag_id = ? ORDER BY track_id`).all(tagId) as Array<{ track_id: string }>).map((r) => r.track_id);

// Stand-in for master.db's MyTag table: name (case-insensitive) → id, like
// writer.apply_mytag_ensure's reuse rule. `fail` names ops the writer errors.
function stubSidecar(rbTags: Record<string, string> = {}, fail: Set<string> = new Set()) {
	const byName = new Map(Object.entries(rbTags).map(([n, id]) => [n.toLowerCase(), id]));
	let next = 3_000_000_001;
	const batches: Array<Array<WriteOp | MyTagEnsureOp>> = [];
	let backups = 0;
	const sidecar = {
		backup: async () => { backups++; return { path: `backup/${backups}.db`, sizeBytes: 1, takenAtMs: 1 }; },
		openForWrite: async () => ({ ok: true, path: dbPath }),
		listStaleRelations: async () => ({ stale: [] }),
		applyWriteBatch: async (ops: Array<WriteOp | MyTagEnsureOp>) => {
			batches.push(ops);
			return {
				results: ops.map((op): WriteOpResult => {
					if (op.kind !== 'mytag_ensure') return { kind: op.kind, changed: true, inserted: 1 };
					if (fail.has(op.name)) return { kind: op.kind, error: 'ValueError: boom', skipped: true };
					const k = op.name.trim().toLowerCase();
					const had = byName.get(k);
					const id = had ?? String(next++);
					byName.set(k, id);
					return { kind: op.kind, curator_tag_id: op.curator_tag_id, rb_tag_id: id, created: !had, revived: false };
				}),
			};
		},
		commitAndClose: async (ids: string[]) => ({ baselines: Object.fromEntries(ids.map((id) => [id, 1_700_000_000_000])) }),
		verify: async () => ({ ok: true, pragma_error: null, failures: [] }),
	} as unknown as RekordboxSidecar;
	return { sidecar, batches, backups: () => backups };
}

const FLAGS: ExportFlags = { syncMetadata: false, syncCues: false, syncTags: true, syncPlaylist: false };

async function push(
	sidecar: RekordboxSidecar,
	target: { kind: 'tracks'; ids: string[] } | { kind: 'updates' },
	flags: Partial<ExportFlags> = {},
	group?: MyTagGroupChoice,
) {
	const exporter = new RekordboxExporter(db, sidecar, undefined, undefined, group ? () => group : undefined);
	return exporter.runExport({
		targetKind: target.kind,
		targetIds: target.kind === 'tracks' ? target.ids : [],
		flags: { ...FLAGS, ...flags },
		dbPath,
	});
}

const ensureOps = (batch: Array<WriteOp | MyTagEnsureOp>): MyTagEnsureOp[] =>
	batch.filter((o): o is MyTagEnsureOp => o.kind === 'mytag_ensure');
const tagsOps = (batch: Array<WriteOp | MyTagEnsureOp>) =>
	batch.filter((o): o is Extract<WriteOp, { kind: 'tags' }> => o.kind === 'tags');

describe('push: Curator-made tags get a MyTag', () => {
	it('ensures the tag in its own session, links it, then pushes the membership — one backup', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'uuid-blue', 'bluerama');
		const stub = stubSidecar();
		const result = await push(stub.sidecar, { kind: 'tracks', ids: ['t1'] });

		expect(stub.batches).toHaveLength(2);
		expect(ensureOps(stub.batches[0]!)).toEqual([
			{ kind: 'mytag_ensure', curator_tag_id: 'uuid-blue', name: 'bluerama', group_id: null, group_name: 'attributes' },
		]);
		expect(links()).toEqual([{ tag_id: 'uuid-blue', rb_tag_id: '3000000001' }]);
		expect(tagsOps(stub.batches[1]!)).toEqual([{ kind: 'tags', rb_content_id: 'C1', rb_tag_ids: ['3000000001'] }]);
		expect(stub.backups()).toBe(1);
		expect(result.backupPath).toBe('backup/1.db');
		expect(result.writeFailures).toEqual([]);
		// The Curator tag keeps its account-wide id.
		expect(tagIds()).toEqual(['uuid-blue']);
	});

	it('a linked tag is not ensured again — the next push goes straight to the tags op', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'uuid-blue', 'bluerama');
		await push(stubSidecar().sidecar, { kind: 'tracks', ids: ['t1'] });
		const again = stubSidecar();
		await push(again.sidecar, { kind: 'tracks', ids: ['t1'] });
		expect(again.batches).toHaveLength(1);
		expect(ensureOps(again.batches[0]!)).toEqual([]);
		expect(tagsOps(again.batches[0]!)[0]!.rb_tag_ids).toEqual(['3000000001']);
	});

	it('carries the group from Settings', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'uuid-blue', 'bluerama');
		const stub = stubSidecar();
		await push(stub.sidecar, { kind: 'tracks', ids: ['t1'] }, {}, { id: '3', name: 'Situation' });
		expect(ensureOps(stub.batches[0]!)[0]).toMatchObject({ group_id: '3', group_name: 'Situation' });
	});

	it('leaves alone: tags only on unlinked tracks, system tags, imported rb tags, and pushes without tags', async () => {
		seedLinkedTrack('t1', 'C1');
		seedUnlinkedTrack('t2');
		tag('t2', 'uuid-soundtest', 'soundtest');
		tag('t1', 'interested', 'Interested', 'system');
		tag('t1', 'rb_55', 'vocal');
		const stub = stubSidecar();
		await push(stub.sidecar, { kind: 'updates' });
		expect(stub.batches.flatMap(ensureOps)).toEqual([]);
		expect(links()).toEqual([]);

		seedLinkedTrack('t3', 'C3');
		tag('t3', 'uuid-blue', 'bluerama');
		const off = stubSidecar();
		await push(off.sidecar, { kind: 'tracks', ids: ['t3'] }, { syncTags: false, syncMetadata: true });
		expect(off.batches.flatMap(ensureOps)).toEqual([]);
	});

	it('"Sync updates" reaches tracks pushed before the tag had rb identity, and rebuilds their comment block', async () => {
		seedLinkedTrack('t1', 'C1', 'deep /* vocal */');
		seedLinkedTrack('t2', 'C2');
		tag('t1', 'rb_55', 'vocal');
		tag('t1', 'uuid-blue', 'bluerama');
		tag('t2', 'uuid-blue', 'bluerama');
		const stub = stubSidecar();
		await push(stub.sidecar, { kind: 'updates' }, { syncMetadata: true });

		const main = stub.batches[1]!;
		expect(tagsOps(main).map((o) => [o.rb_content_id, o.rb_tag_ids])).toEqual([
			['C1', ['55', '3000000001']],
			['C2', ['3000000001']],
		]);
		const t1 = main.find((o): o is Extract<WriteOp, { kind: 'track' }> => o.kind === 'track' && o.rb_content_id === 'C1')!;
		expect(t1.fields.Comment).toBe('deep /* vocal / bluerama */');
	});

	it('a failed ensure leaves the tag Curator-only and reports it', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'rb_55', 'vocal');
		tag('t1', 'uuid-blue', 'bluerama');
		const stub = stubSidecar({}, new Set(['bluerama']));
		const result = await push(stub.sidecar, { kind: 'tracks', ids: ['t1'] });
		expect(links()).toEqual([]);
		expect(result.writeFailures).toEqual([
			{ kind: 'mytag_ensure', target: 'uuid-blue', targetLabel: 'bluerama', error: 'ValueError: boom' },
		]);
		expect(tagsOps(stub.batches[1]!)[0]!.rb_tag_ids).toEqual(['55']);
	});

	it('folds into the imported same-name rb tag rather than linking a second tag to one MyTag', async () => {
		seedLinkedTrack('t1', 'C1');
		seedLinkedTrack('t2', 'C2');
		tag('t1', 'rb_200', 'Vocal');
		tag('t2', 'uuid-vocal', 'vocal');
		const stub = stubSidecar({ Vocal: '200' });
		await push(stub.sidecar, { kind: 'tracks', ids: ['t2'] });
		expect(links()).toEqual([]);
		expect(tagIds()).toEqual(['rb_200']);
		expect(membersOf('rb_200')).toEqual(['t1', 't2']);
		expect(tagsOps(stub.batches[1]!)).toEqual([{ kind: 'tags', rb_content_id: 'C2', rb_tag_ids: ['200'] }]);
	});

	it('two Curator tags that differ only in case resolve to one MyTag and one tag', async () => {
		seedLinkedTrack('t1', 'C1');
		seedLinkedTrack('t2', 'C2');
		tag('t1', 'uuid-a', 'Warmup');
		tag('t2', 'uuid-b', 'warmup');
		const stub = stubSidecar();
		await push(stub.sidecar, { kind: 'tracks', ids: ['t1', 't2'] });
		expect(links()).toEqual([{ tag_id: 'uuid-a', rb_tag_id: '3000000001' }]);
		expect(tagIds()).toEqual(['uuid-a']);
		expect(membersOf('uuid-a')).toEqual(['t1', 't2']);
	});
});

describe('Settings: which group a new MyTag lands in', () => {
	const groups = [{ id: '1', name: 'Genre' }, { id: '2', name: 'Components' }, { id: '4', name: 'attributes' }];
	it('the chosen id, else the chosen name (case-insensitive), else the first group — the writer\'s rule', () => {
		expect(pickMyTagGroup(groups, { id: '2', name: 'whatever' })?.id).toBe('2');
		expect(pickMyTagGroup(groups, { id: '99', name: ' Attributes ' })?.id).toBe('4');
		expect(pickMyTagGroup(groups, { id: null, name: DEFAULT_MYTAG_GROUP_NAME })?.id).toBe('4');
		expect(pickMyTagGroup(groups, { id: null, name: 'gone' })?.id).toBe('1');
		expect(pickMyTagGroup([], { id: null, name: 'attributes' })).toBeNull();
	});
});

// ── pull ────────────────────────────────────────────────────────────────────

interface MyTagFrame { rb_tag_id: string; rb_local_usn: number; rb_local_deleted: boolean; name: string; color: string | null; tracks: string[]; is_group?: boolean }

async function pull(frames: MyTagFrame[]) {
	const emitter = new EventEmitter();
	const sidecar = Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const f of frames) emitter.emit('event', { event: 'mytag', frame: { row: f } });
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
	const opts: RunImportOptions = {
		mode: 'full',
		flags: { syncTracks: false, syncPlaylists: false, syncMyTags: true, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, 'master.db'),
		peaksDir: join(dir, 'peaks'),
	};
	return new RekordboxImporter(db, sidecar).runImport(opts);
}
const frame = (id: string, name: string, extra: Partial<MyTagFrame> = {}): MyTagFrame =>
	({ rb_tag_id: id, rb_local_usn: 5, rb_local_deleted: false, name, color: null, tracks: [], ...extra });

describe('pull: linked MyTags land on the Curator tag', () => {
	it('the MyTag the push created comes back onto the linked tag — no rb_ twin — and a rename follows', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'uuid-blue', 'bluerama');
		await push(stubSidecar().sidecar, { kind: 'tracks', ids: ['t1'] });

		await pull([frame('3000000001', 'blue-rama', { tracks: ['C1'] })]);
		expect(tagIds()).toEqual(['uuid-blue']);
		expect(sqlite.prepare(`SELECT name FROM tag WHERE id = 'uuid-blue'`).pluck().get()).toBe('blue-rama');
		expect(membersOf('uuid-blue')).toEqual(['t1']);
	});

	it('a tombstoned linked MyTag is kept while curated (the push revives it)', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'uuid-blue', 'bluerama');
		await push(stubSidecar().sidecar, { kind: 'tracks', ids: ['t1'] });

		const totals = await pull([frame('3000000001', 'bluerama', { rb_local_deleted: true })]);
		expect(totals.myTagsPruned).toBe(0);
		expect(tagIds()).toEqual(['uuid-blue']);
		expect(links()).toEqual([{ tag_id: 'uuid-blue', rb_tag_id: '3000000001' }]);
	});

	it('a dead linked tag merges into a live same-name rb tag', async () => {
		seedLinkedTrack('t1', 'C1');
		tag('t1', 'uuid-blue', 'bluerama');
		sqlite.prepare(`INSERT INTO tag (id, name, kind) VALUES ('rb_77', 'Bluerama', 'user')`).run();
		await push(stubSidecar().sidecar, { kind: 'tracks', ids: ['t1'] });

		const totals = await pull([frame('77', 'Bluerama'), frame('3000000001', 'bluerama', { rb_local_deleted: true })]);
		expect(totals.myTagsMerged).toBe(1);
		expect(tagIds()).toEqual(['rb_77']);
		expect(membersOf('rb_77')).toEqual(['t1']);
	});

	it('group folders are never tags: earlier imports of them are pruned, an assigned one is kept', async () => {
		seedUnlinkedTrack('t1');
		sqlite.prepare(`INSERT INTO tag (id, name, kind) VALUES ('rb_1', 'Genre', 'user'), ('rb_4', 'attributes', 'user')`).run();
		tag('t1', 'rb_4', 'attributes');
		const totals = await pull([
			frame('1', 'Genre', { is_group: true }),
			frame('4', 'attributes', { is_group: true }),
			frame('9', 'Situation', { is_group: true }),
		]);
		expect(totals.myTagsPruned).toBe(1);
		expect(totals.myTagsUpserted).toBe(0);
		expect(tagIds()).toEqual(['rb_4']);
	});
});
