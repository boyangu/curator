// Regression coverage for the Curator→rekordbox push NOT clobbering rb-side
// metadata/tags when Curator's own values are empty. The bug: buildWriteOps
// sent Title/Artist/Album/Label/Genre unconditionally and ALWAYS emitted a
// tags op, so a sparse Curator row (empty artists, rating 0, no rb-origin
// tags) pushed null/empty values that writer.py interprets as "clear this
// field" — silently wiping the artist, rating, and tags a track had in
// rekordbox. These tests exercise the REAL exporter diff against a migrated
// temp DB so the omit-if-empty guard is pinned, not just typechecked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxExporter } from './exporter.js';
import type { WriteOp } from './sidecar.js';
import type { ArtistCreditFormat, TrackArtist } from '@curator/shared';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

interface SeedFields {
	artists?: TrackArtist[];
	albumTitle?: string | null;
	label?: string | null;
	genre?: string | null;
	rating?: number | null;
	comment?: string | null;
}

function seedTrack(id: string, rbContentId: string, fields: SeedFields = {}): void {
	sqlite.prepare(
		`INSERT INTO track (id, title, artists, album_title, label, genre, rating, comment, state)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unsorted')`,
	).run(
		id,
		id,
		JSON.stringify(fields.artists ?? []),
		fields.albumTitle ?? null,
		fields.label ?? null,
		fields.genre ?? null,
		fields.rating ?? null,
		fields.comment ?? null,
	);
	sqlite.prepare(
		// pushed_at set: these are links the exporter has written before, so
		// only the updatedAt-vs-seen rule (and the stale-comment sweep) puts
		// them in the "Sync updates" scope — not the never-pushed leg.
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, pushed_at)
		 VALUES (?, ?, 0, 0, 0, 0)`,
	).run(id, rbContentId);
}

function addTag(trackId: string, tagId: string, name: string): void {
	sqlite.prepare(`INSERT OR IGNORE INTO tag (id, name, kind) VALUES (?, ?, 'user')`).run(tagId, name);
	sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES (?, ?)`).run(trackId, tagId);
}

function buildOps(trackId: string, flags: Partial<{ syncMetadata: boolean; syncTags: boolean }>, fmt?: ArtistCreditFormat): WriteOp[] {
	const exporter = new RekordboxExporter(db, {} as never, undefined, fmt ? () => fmt : undefined);
	const opts = {
		targetKind: 'tracks' as const,
		targetIds: [trackId],
		flags: { syncMetadata: false, syncCues: false, syncTags: false, syncPlaylist: false, ...flags },
		dbPath,
	};
	const targets = (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: unknown[]; playlistOrders?: unknown[] } }).resolveTargets(opts);
	return (exporter as unknown as { buildWriteOps: (o: typeof opts, l: unknown, p: unknown) => { ops: WriteOp[] } })
		.buildWriteOps(opts, targets.linked, targets.playlistOrders ?? []).ops;
}

function trackOp(trackId: string, fmt?: ArtistCreditFormat): Extract<WriteOp, { kind: 'track' }> | undefined {
	return buildOps(trackId, { syncMetadata: true }, fmt).find((o): o is Extract<WriteOp, { kind: 'track' }> => o.kind === 'track');
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-push-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('export: metadata omit-if-empty (no rb clobber)', () => {
	it('omits every text field a sparse Curator row has no value for', () => {
		// Empty artists, null album/label/genre — the streaming-first / un-pulled
		// case. None of these may reach the wire, or the writer clears rb.
		seedTrack('t1', 'C1', { artists: [] });
		const op = trackOp('t1')!;
		expect('ArtistName' in op.fields).toBe(false);
		expect('AlbumName' in op.fields).toBe(false);
		expect('LabelName' in op.fields).toBe(false);
		expect('GenreName' in op.fields).toBe(false);
		// Title is notNull and seeded to the id, so it's the one field present.
		expect(op.fields.Title).toBe('t1');
	});

	it('omits Rating when the Curator value is 0 (rb "unrated" sentinel)', () => {
		// reader.py imports an unrated rb track as rating 0, not null. Pushing
		// 0 would de-rate a track the user rated in rekordbox.
		seedTrack('t2', 'C2', { artists: [{ name: 'Murat' }], rating: 0 });
		const op = trackOp('t2')!;
		expect('Rating' in op.fields).toBe(false);
		expect(op.fields.ArtistName).toBe('Murat');
	});

	it('formats Title and Artist with the credit format (separator + remix style)', () => {
		sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('t9', 'Drown - Massano Remix', ?, 'unsorted')`)
			.run(JSON.stringify([{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' }]));
		sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, pushed_at) VALUES ('t9', 'C9', 0, 0, 0, 0)`).run();
		const dflt = trackOp('t9')!;
		expect(dflt.fields.Title).toBe('Drown (Massano Remix)');
		expect(dflt.fields.ArtistName).toBe('Lane 8, Massano');
		const alt = trackOp('t9', { separator: '/', remixStyle: 'dash' })!;
		expect(alt.fields.Title).toBe('Drown - Massano Remix');
		expect(alt.fields.ArtistName).toBe('Lane 8 / Massano');
	});

	it('"updates" scope sweeps in a linked track whose formatted strings drifted from the baseline', () => {
		// Untouched since the last push (pushed_at + seen set, updatedAt old),
		// baseline holds Spotify's dash form; the parenthesis default now
		// formats the title differently → must be in scope. A track whose
		// baseline already matches must not.
		sqlite.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES ('u1', 'Drown - Massano Remix', ?, 'unsorted', 1000)`)
			.run(JSON.stringify([{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' }]));
		sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, pushed_at, rb_updated_at_seen, fields_seen) VALUES ('u1', 'CU1', 0, 0, 0, 5000, 5000, ?)`)
			.run(JSON.stringify({ title: 'Drown - Massano Remix', artist: 'Lane 8, Massano' }));
		sqlite.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES ('u2', 'Plain', ?, 'unsorted', 1000)`)
			.run(JSON.stringify([{ name: 'A' }]));
		sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, pushed_at, rb_updated_at_seen, fields_seen) VALUES ('u2', 'CU2', 0, 0, 0, 5000, 5000, ?)`)
			.run(JSON.stringify({ title: 'Plain', artist: 'A' }));
		const resolve = (fmt?: ArtistCreditFormat) => {
			const exporter = new RekordboxExporter(db, {} as never, undefined, fmt ? () => fmt : undefined);
			const opts = { targetKind: 'updates' as const, targetIds: [], flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false }, dbPath };
			return (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: { curatorTrackId: string }[] } }).resolveTargets(opts).linked.map((l) => l.curatorTrackId);
		};
		expect(resolve()).toEqual(['u1']);
		// With the dash style the baseline already matches → nothing to push.
		expect(resolve({ separator: ',', remixStyle: 'dash' })).toEqual([]);
	});

	it('still pushes real values (guard does not over-suppress)', () => {
		seedTrack('t3', 'C3', {
			artists: [{ name: 'Murat' }, { name: 'Guest' }],
			albumTitle: 'Some Album',
			label: 'Some Label',
			genre: 'Melodic',
			rating: 4,
		});
		const op = trackOp('t3')!;
		expect(op.fields.ArtistName).toBe('Murat, Guest');
		expect(op.fields.AlbumName).toBe('Some Album');
		expect(op.fields.LabelName).toBe('Some Label');
		expect(op.fields.GenreName).toBe('Melodic');
		expect(op.fields.Rating).toBe(4);
	});
});

describe('export: tags skip-empty (no rb wipe)', () => {
	it('emits NO tags op when the track has no rb-origin tags', () => {
		// An empty tag set would wipe-and-re-add to nothing, deleting every
		// DjmdSongMyTag row the track had in rekordbox.
		seedTrack('t4', 'C4', { artists: [{ name: 'Murat' }] });
		const ops = buildOps('t4', { syncTags: true });
		expect(ops.find((o) => o.kind === 'tags')).toBeUndefined();
	});

	it('skips a track whose only tags are Curator-origin (non rb_ prefix)', () => {
		// The push only manages rb-origin tags; a curator-only tag set still
		// resolves to an empty rb_tag_ids list and must not wipe rb's tags.
		seedTrack('t5', 'C5', { artists: [{ name: 'Murat' }] });
		addTag('t5', 'cur_local', 'My Vibe');
		const ops = buildOps('t5', { syncTags: true });
		expect(ops.find((o) => o.kind === 'tags')).toBeUndefined();
	});

	it('still pushes a non-empty rb-origin tag set', () => {
		seedTrack('t6', 'C6', { artists: [{ name: 'Murat' }] });
		addTag('t6', 'rb_100', 'Peak Time');
		addTag('t6', 'cur_local', 'My Vibe'); // curator-only tag is filtered out
		const op = buildOps('t6', { syncTags: true }).find((o): o is Extract<WriteOp, { kind: 'tags' }> => o.kind === 'tags');
		expect(op).toBeTruthy();
		expect(op!.rb_tag_ids).toEqual(['100']);
	});
});

// rekordbox's text search reads the Comment column, not DjmdSongMyTag; with
// "Add MyTag to Comments" on, rekordbox keeps a `/* tag / tag */` block at
// the end of the comment. The push rebuilds that block from the rb tag set
// so a tag added in Curator is searchable in rekordbox (tag-comment.ts).
describe('export: MyTag comment block mirrors the rb tag set', () => {
	const metaOp = (trackId: string, flags: Partial<{ syncMetadata: boolean; syncTags: boolean }>) =>
		buildOps(trackId, { syncMetadata: true, ...flags }).find((o): o is Extract<WriteOp, { kind: 'track' }> => o.kind === 'track')!;

	it('appends the block for a track tagged in Curator, in added_at order', () => {
		seedTrack('m1', 'M1', { artists: [{ name: 'Murat' }], comment: null });
		addTag('m1', 'rb_1', 'p3');
		sqlite.prepare(`UPDATE track_tag SET added_at = 1000 WHERE track_id = 'm1' AND tag_id = 'rb_1'`).run();
		addTag('m1', 'rb_2', 'sunset');
		sqlite.prepare(`UPDATE track_tag SET added_at = 2000 WHERE track_id = 'm1' AND tag_id = 'rb_2'`).run();
		expect(metaOp('m1', { syncTags: true }).fields.Comment).toBe(' /* p3 / sunset */');
	});

	it('keeps rekordbox\'s existing token order and only appends the new tag', () => {
		seedTrack('m2', 'M2', { artists: [{ name: 'Murat' }], comment: 'bought /* b0 / p3 / house */' });
		for (const [id, name] of [['rb_10', 'house'], ['rb_11', 'p3'], ['rb_12', 'b0'], ['rb_13', 'sunset']] as const) addTag('m2', id, name);
		expect(metaOp('m2', { syncTags: true }).fields.Comment).toBe('bought /* b0 / p3 / house / sunset */');
	});

	it('leaves the comment verbatim when tags are not in scope or the track has no rb tags', () => {
		seedTrack('m3', 'M3', { artists: [{ name: 'Murat' }], comment: ' /* stale / block */' });
		addTag('m3', 'rb_20', 'fresh');
		expect(metaOp('m3', { syncTags: false }).fields.Comment).toBe(' /* stale / block */');
		seedTrack('m4', 'M4', { artists: [{ name: 'Murat' }], comment: ' /* rb-managed */' });
		addTag('m4', 'cur_only', 'Curator Tag'); // no rb identity → not mirrored, block untouched
		expect(metaOp('m4', { syncTags: true }).fields.Comment).toBe(' /* rb-managed */');
	});

	it('an open comment conflict still shields the derived value', () => {
		seedTrack('m5', 'M5', { artists: [{ name: 'Murat' }], comment: null });
		addTag('m5', 'rb_30', 'peak');
		sqlite.prepare(
			`INSERT INTO sync_conflict (id, provider, track_id, kind, field_key, detected_at) VALUES ('c1', 'rekordbox', 'm5', 'field', 'comment', 1)`,
		).run();
		expect('Comment' in metaOp('m5', { syncTags: true }).fields).toBe(false);
	});

	it('advanceBaselines mirrors the pushed comment into track.comment without bumping updatedAt', () => {
		seedTrack('m6', 'M6', { artists: [{ name: 'Murat' }], comment: null });
		addTag('m6', 'rb_40', 'sunset');
		sqlite.prepare(`UPDATE track SET updated_at = 5000 WHERE id = 'm6'`).run();
		const exporter = new RekordboxExporter(db, {} as never);
		const op = metaOp('m6', { syncTags: true });
		(exporter as unknown as { advanceBaselines: (l: unknown, b: unknown, w: WriteOp[]) => void })
			.advanceBaselines([{ curatorTrackId: 'm6', rbContentId: 'M6' }], { M6: 9000 }, [op]);
		const row = sqlite.prepare(`SELECT comment, updated_at FROM track WHERE id = 'm6'`).get() as { comment: string; updated_at: number };
		expect(row.comment).toBe(' /* sunset */');
		expect(row.updated_at).toBe(5000);
		const link = sqlite.prepare(`SELECT fields_seen FROM rekordbox_link WHERE track_id = 'm6'`).get() as { fields_seen: string };
		expect(JSON.parse(link.fields_seen).comment).toBe(' /* sunset */');
	});

	it('"Sync updates" sweeps in tracks the sidecar reports as bound to a tombstoned relation row', async () => {
		seedTrack('s1', 'S1', { artists: [{ name: 'Lane 8' }] });
		seedTrack('s2', 'S2', { artists: [{ name: 'Depart' }] });
		sqlite.prepare(`UPDATE track SET updated_at = 1000`).run();
		sqlite.prepare(`UPDATE rekordbox_link SET rb_updated_at_seen = 2000`).run();
		const fakeSidecar = { listStaleRelations: async () => ({ stale: [
			{ rbContentId: 'S1', fields: ['artist'], myTags: [] },
			{ rbContentId: 'GONE', fields: ['artist'], myTags: [] },
		] }) };
		const exporter = new RekordboxExporter(db, fakeSidecar as never);
		const opts = { targetKind: 'updates' as const, targetIds: [], dbPath, flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false } };
		const linked: Array<{ curatorTrackId: string; rbContentId: string }> = [];
		const sweep = (exporter as unknown as { sweepStaleRelations: (o: unknown, l: typeof linked) => Promise<number> });
		expect(await sweep.sweepStaleRelations(opts, linked)).toBe(1);
		expect(linked).toEqual([{ curatorTrackId: 's1', rbContentId: 'S1' }]);
		// Already in the dirty set → not added twice.
		expect(await sweep.sweepStaleRelations(opts, linked)).toBe(0);
		// Probe failure is non-fatal and leaves the set alone.
		const broken = new RekordboxExporter(db, { listStaleRelations: async () => { throw new Error('sidecar down'); } } as never);
		expect(await (broken as unknown as typeof sweep).sweepStaleRelations(opts, linked)).toBe(0);
		// A pre-0.6.1 bundled sidecar (id-only shape) is treated as a probe failure.
		const stale = new RekordboxExporter(db, { listStaleRelations: async () => ({ rbContentIds: ['S2'] }) } as never);
		expect(await (stale as unknown as typeof sweep).sweepStaleRelations(opts, linked)).toBe(0);
		// Not an updates sync → no probe at all.
		expect(await sweep.sweepStaleRelations({ ...opts, targetKind: 'tracks' as const }, linked)).toBe(0);
	});

	it('"Sync updates" sweeps in a clean track whose block is stale, and skips one that matches', () => {
		// Both tracks are "clean" for the updates selection (not edited since
		// their last verified push: updatedAt < pushedAt).
		seedTrack('u1', 'U1', { artists: [{ name: 'Murat' }], comment: ' /* p3 */' });
		addTag('u1', 'rb_50', 'p3');
		addTag('u1', 'rb_51', 'sunset');
		seedTrack('u2', 'U2', { artists: [{ name: 'Murat' }], comment: ' /* sunset / p3 */' });
		addTag('u2', 'rb_50', 'p3');
		addTag('u2', 'rb_51', 'sunset');
		sqlite.prepare(`UPDATE track SET updated_at = 1000`).run();
		sqlite.prepare(`UPDATE rekordbox_link SET rb_updated_at_seen = 2000, pushed_at = 2000`).run();
		const exporter = new RekordboxExporter(db, {} as never);
		const resolve = (syncTags: boolean) => (exporter as unknown as { resolveTargets: (o: unknown) => { linked: Array<{ curatorTrackId: string }> } })
			.resolveTargets({ targetKind: 'updates', targetIds: [], dbPath, flags: { syncMetadata: true, syncCues: false, syncTags, syncPlaylist: false } })
			.linked.map((l) => l.curatorTrackId);
		expect(resolve(true)).toEqual(['u1']);
		expect(resolve(false)).toEqual([]);
	});
});
