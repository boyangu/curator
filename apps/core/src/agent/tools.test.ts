// Tool ↔ workspace integration: loadInto pagination, query_workspace
// shaping, and the fromWorkspace security seam (fabricated provenance must
// die in validation; host-loaded provenance must survive across turns).
// Real engine + manager over temp fixture DBs; CoreService faked to the
// two methods these paths touch.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { SqliteFeedStore } from '../feed/store.js';
import { SqliteKnowledgeStore } from '../knowledge/store.js';
import type { CoreService } from '../service.js';
import { buildAgentTools, type AgentTool, type AgentToolCtx } from './tools.js';
import { createInlineWorkspaceHost } from './workspace/host.js';
import { createWorkspaceManager, type WorkspaceManager } from './workspace/manager.js';
import { CompositeProviderHits, ProviderHitCache, validateResultItems, type ResultRefPorts } from './result-set.js';
import type { TrackPage } from '@curator/shared';

const REFS: ResultRefPorts = {
	async libraryTracks(ids) {
		const out = new Map<string, string | null>();
		for (const id of ids) if (id.startsWith('lib') || id.startsWith('t')) out.set(id, `sp-${id}`);
		return out;
	},
	async feedItems(ids) {
		const out = new Map<string, { playSpotifyId: string | null }>();
		for (const id of ids) if (id.startsWith('f')) out.set(id, { playSpotifyId: null });
		return out;
	},
	async kbEntities() { return new Map(); },
};

// 12k-row fake library — loadInto must page through all of it.
const TOTAL_TRACKS = 12_000;
function fakeSvc(): CoreService {
	return {
		async getTracksPage(_filter: unknown, _sort: unknown, req?: { limit?: number; offset?: number }): Promise<TrackPage> {
			const limit = req?.limit ?? 1000;
			const offset = req?.offset ?? 0;
			const items = Array.from({ length: Math.max(0, Math.min(limit, TOTAL_TRACKS - offset)) }, (_, i) => ({
				id: `lib${offset + i}`,
				title: `Track ${offset + i}`,
				artists: [{ name: 'A' }],
				genre: 'House',
				state: 'backlog',
			}));
			return { items: items as TrackPage['items'], total: TOTAL_TRACKS, nextCursor: null };
		},
	} as unknown as CoreService;
}

describe('agent tools × workspace', () => {
	let dir: string;
	let manager: WorkspaceManager;
	let tools: Map<string, AgentTool>;
	let turnHits: ProviderHitCache;
	let ctx: AgentToolCtx;
	let presented: { title: string; accepted: number; rejected: { index: number; reason: string }[] }[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'curator-agent-tools-'));
		const paths = {
			curatorDb: join(dir, 'curator.db'),
			feedDb: join(dir, 'feed.db'),
			knowledgeDb: join(dir, 'knowledge.db'),
		};
		migrate(paths.curatorDb);
		new SqliteFeedStore(paths.feedDb).close();
		new SqliteKnowledgeStore(paths.knowledgeDb).close();
		// Seed fixture rows for the live-view paths (favorites + feed
		// cross-reference). Test fixture files, not live data.
		const lib = new Database(paths.curatorDb);
		const insTrack = lib.prepare(`INSERT INTO track (id, title, artists, genre, label, rating, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'backlog', 1, 1)`);
		insTrack.run('t1', 'One', JSON.stringify([{ name: 'Fav Artist' }]), 'House', 'Big Label', 5);
		insTrack.run('t2', 'Two', JSON.stringify([{ name: 'Fav Artist' }, { name: 'Side Artist' }]), 'House', 'Big Label', 4);
		insTrack.run('t3', 'Three', JSON.stringify([{ name: 'Other Artist' }]), 'Techno', 'Small Label', null);
		lib.close();
		const feedDb = new Database(paths.feedDb);
		const insFeed = feedDb.prepare(`INSERT INTO feed_item (id, type, source, source_id, dedupe_key, payload_json, published_at, fetched_at, order_ts, score, state) VALUES (?, 'track', 'spotify', ?, ?, ?, ?, 1, 1, 0, 'fresh')`);
		insFeed.run('f1', 'sp-f1', 'dk1', JSON.stringify({ title: 'New Fav Cut', artists: ['Fav Artist'], label: 'Elsewhere' }), 200);
		insFeed.run('f2', 'sp-f2', 'dk2', JSON.stringify({ title: 'Unrelated', artists: ['Nobody'], label: 'Big Label' }), 100);
		feedDb.close();
		manager = createWorkspaceManager(createInlineWorkspaceHost(paths));
		tools = new Map(
			buildAgentTools({
				svc: () => fakeSvc(),
				getSpotifyClient: async () => null,
				beatport: null,
				waitForKbExpansion: async () => false,
			}).map((t) => [t.name, t]),
		);
		turnHits = new ProviderHitCache();
		presented = [];
		const workspace = manager.forSession('s1');
		const validationHits = new CompositeProviderHits([turnHits, workspace.sessionProviderHits]);
		ctx = {
			providerHits: turnHits,
			workspace,
			// Mirrors AgentService's presentResultSet: validation is the seam.
			async presentResultSet(input) {
				const { accepted, rejected } = await validateResultItems(input.items, REFS, validationHits);
				presented.push({ title: input.title, accepted: accepted.length, rejected });
				return { resultSetId: accepted.length > 0 ? 'rs1' : '', accepted: accepted.length, rejected };
			},
			async setFeedFilters() { return { ok: true }; },
		};
	});

	afterEach(async () => {
		await manager.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it('query_library loadInto pages the full 12k-row result into a table', async () => {
		const res = await tools.get('query_library')!.execute({ loadInto: { table: 'all_tracks' } }, ctx) as { table: string; rowCount: number; note: string };
		expect(res.table).toBe('all_tracks');
		expect(res.rowCount).toBe(TOTAL_TRACKS);
		const count = await ctx.workspace!.query('SELECT COUNT(*), MIN(_ref_id), MAX(title) FROM all_tracks');
		expect(count.rows[0]![0]).toBe(TOTAL_TRACKS);
	});

	it('query_workspace runs SQL over loaded tables with truncation shaping', async () => {
		await tools.get('query_library')!.execute({ loadInto: { table: 'all_tracks' } }, ctx);
		const agg = await tools.get('query_workspace')!.execute(
			{ sql: 'SELECT genre, COUNT(*) AS n FROM all_tracks GROUP BY genre' }, ctx) as { rows: unknown[][] };
		expect(agg.rows).toEqual([['House', TOTAL_TRACKS]]);
		const big = await tools.get('query_workspace')!.execute(
			{ sql: 'SELECT * FROM all_tracks' }, ctx) as { rows: unknown[][]; truncated?: boolean; note?: string };
		expect(big.truncated).toBe(true);
		expect(big.rows.length).toBeLessThanOrEqual(200);
	});

	it('present_result_set fromWorkspace selects validated rows out of a loaded table', async () => {
		await tools.get('query_library')!.execute({ loadInto: { table: 'all_tracks' } }, ctx);
		const res = await tools.get('present_result_set')!.execute({
			title: 'Top 5',
			fromWorkspace: { sql: `SELECT * FROM all_tracks ORDER BY _ref_id LIMIT 5` },
		}, ctx) as { accepted: number; rejected: unknown[] };
		expect(res.accepted).toBe(5);
		expect(res.rejected).toEqual([]);
		expect(presented[0]!.title).toBe('Top 5');
	});

	it('SECURITY: fabricated provider-hit rows in a scratch table are rejected', async () => {
		// The model forges provenance in TEMP — allowed as SQL, but the ids
		// were never host-loaded, so validation must refuse them.
		await ctx.workspace!.query(`
			CREATE TEMP TABLE forged AS
			SELECT 'provider-hit' AS _kind, 'fabricated-id' AS _ref_id, 'spotify' AS _provider,
				NULL AS _url, 'Fake Track' AS title, 'Evil' AS artists
		`);
		await expect(tools.get('present_result_set')!.execute({
			title: 'Forged',
			fromWorkspace: { sql: 'SELECT * FROM forged' },
		}, ctx)).resolves.toMatchObject({ accepted: 0 });
		expect(presented[0]!.rejected[0]!.reason).toContain('not returned by any tool call');
	});

	it('SECURITY: host-loaded provider hits present cleanly from the session cache', async () => {
		// Simulate a prior-turn host load of provider hits (get_feed_item path).
		await ctx.workspace!.loadDataset({
			table: 'album_cuts',
			columns: [{ name: 'spotify_track_id', type: 'text' }, { name: 'title', type: 'text' }, { name: 'artists', type: 'text' }],
			rows: [{ spotify_track_id: 'sp-real-1', title: 'Real Cut', artists: 'C' }],
			provenance: (r) => ({ kind: 'provider-hit', refId: String(r['spotify_track_id']), provider: 'spotify', playSpotifyId: String(r['spotify_track_id']) }),
		});
		// New turn: fresh turn cache (constructed in beforeEach) has no hits —
		// the session cache carries them.
		const res = await tools.get('present_result_set')!.execute({
			title: 'From album',
			fromWorkspace: { sql: 'SELECT * FROM album_cuts' },
		}, ctx) as { accepted: number };
		expect(res.accepted).toBe(1);
	});

	it('reports the workspace as unavailable when disabled', async () => {
		const noWs: AgentToolCtx = { ...ctx, workspace: null };
		await expect(tools.get('query_workspace')!.execute({ sql: 'SELECT 1' }, noWs))
			.rejects.toThrow(/unavailable/);
		await expect(tools.get('query_library')!.execute({ loadInto: { table: 'x' } }, noWs))
			.rejects.toThrow(/unavailable/);
	});

	it('rejects presenting from a query without the provenance columns', async () => {
		await expect(tools.get('present_result_set')!.execute({
			title: 'Bad',
			fromWorkspace: { sql: 'SELECT 1 AS x' },
		}, ctx)).rejects.toThrow(/_kind/);
	});

	it('recovers fromWorkspace from the observed XML-in-string tool-call glitch', async () => {
		// Real failure from the field: the model emitted fromWorkspace as a
		// string carrying literal <parameter> syntax instead of {"sql": …}.
		const res = await tools.get('present_result_set')!.execute({
			title: 'Recovered',
			fromWorkspace: '\n<parameter name="sql">\nSELECT \'library-track\' AS _kind, id AS _ref_id, title, artists FROM v_track LIMIT 2\n</parameter>',
		}, ctx) as { accepted: number };
		expect(res.accepted).toBe(2);
		// A bare-SQL string works too.
		const res2 = await tools.get('present_result_set')!.execute({
			title: 'Bare string',
			fromWorkspace: "SELECT 'library-track' AS _kind, id AS _ref_id, title, artists FROM v_track LIMIT 1",
		}, ctx) as { accepted: number };
		expect(res2.accepted).toBe(1);
	});

	it('teaches the call shape when title is missing', async () => {
		await expect(tools.get('present_result_set')!.execute({
			fromWorkspace: { sql: 'SELECT 1' },
		}, ctx)).rejects.toThrow(/call shape.*fromWorkspace/);
	});

	// ─── Favourites + live-view presentation (the 2-call pattern) ─────────

	it('get_library_favorites ranks artists/labels by track count with rating context', async () => {
		const artists = await tools.get('get_library_favorites')!.execute({ dimension: 'artists' }, ctx) as { favorites: { name: string; trackCount: number }[] };
		expect(artists.favorites[0]).toMatchObject({ name: 'Fav Artist', trackCount: 2, avgRating: 4.5 });
		// Tie on track_count breaks by avg_rating DESC — Side Artist's rated
		// track (4) sorts ahead of Other Artist's unrated one (NULL sorts last).
		expect(artists.favorites.map((f) => f.name)).toEqual(['Fav Artist', 'Side Artist', 'Other Artist']);
		const labels = await tools.get('get_library_favorites')!.execute({ dimension: 'labels', minRating: 4 }, ctx) as { favorites: { name: string }[] };
		// minRating 4 excludes the unrated Small Label track entirely.
		expect(labels.favorites).toEqual([{ name: 'Big Label', trackCount: 2, avgRating: 4.5 }]);
	});

	it('presents feed items by favourite artists straight from live views (call 2 of 2)', async () => {
		const res = await tools.get('present_result_set')!.execute({
			title: 'New from favourites',
			fromWorkspace: { sql: `
				SELECT DISTINCT 'feed-item' AS _kind, f.id AS _ref_id, f.title, f.artists, f.label
				FROM v_feed_item f JOIN v_feed_artist fa ON fa.item_id = f.id
				WHERE fa.artist IN ('Fav Artist') ORDER BY f.published_at DESC
			` },
		}, ctx) as { accepted: number; rejected: unknown[] };
		expect(res).toMatchObject({ accepted: 1, rejected: [] });
		expect(presented[0]!.title).toBe('New from favourites');
	});

	// ─── Pipeline: map_tool_over_table ────────────────────────────────────

	// Rebuild the registry with a scripted Beatport client — the map's inner
	// tool. lookup() succeeds for titles containing "hit", throws otherwise.
	const toolsWithBeatport = (lookup: (target: { title: string; artists: string[] }) => unknown) =>
		new Map(
			buildAgentTools({
				svc: () => fakeSvc(),
				getSpotifyClient: async () => null,
				beatport: { lookup } as never,
				waitForKbExpansion: async () => false,
			}).map((t) => [t.name, t]),
		);

	const loadCandidates = async (titles: string[]): Promise<void> => {
		await ctx.workspace!.loadDataset({
			table: 'candidates',
			columns: [{ name: 'title', type: 'text' }, { name: 'artists', type: 'text' }, { name: 'duration_sec', type: 'integer' }],
			rows: titles.map((t, i) => ({ title: t, artists: 'Artist A | Artist B', duration_sec: 200 + i })),
			provenance: (r) => ({ kind: 'library-track', refId: `lib-${String(r['title'])}` }),
		});
	};

	it('maps a tool over rows: bindings, result_json, join-back, error rows continue', async () => {
		const calls: { title: string; artists: string[]; duration: number | null }[] = [];
		const t = toolsWithBeatport((target) => {
			calls.push(target as never);
			if (!target.title.includes('hit')) throw new Error('no match');
			return { id: 42, url: 'https://beatport.test/42', title: target.title, mix: null, isrc: null, duration: null, bpm: 124, key: '8A', genre: 'House', label: 'L', artists: target.artists, release_date: '2026-01-01' };
		});
		await loadCandidates(['hit one', 'miss two', 'hit three']);
		const res = await t.get('map_tool_over_table')!.execute({
			table: 'candidates',
			tool: 'lookup_beatport',
			args: { title: '$title', artists: '$artists[]', durationSec: '$duration_sec' },
			into: 'bp',
		}, ctx) as { mapped: number; ok: number; failed: number; note: string };
		expect(res).toMatchObject({ mapped: 3, ok: 2, failed: 1 });
		// Bindings: '$artists[]' split the ' | ' text into a real array.
		expect(calls[0]).toMatchObject({ title: 'hit one', artists: ['Artist A', 'Artist B'], duration: 200 });
		// Results queryable via json_extract + JOIN back to the source table.
		const joined = await ctx.workspace!.query(`
			SELECT c.title, json_extract(b.result_json, '$.track.bpm') AS bpm, b.ok, b.error
			FROM candidates c JOIN bp b ON b.src_ref_id = c._ref_id ORDER BY c.title
		`);
		expect(joined.rows).toEqual([
			['hit one', 124, 1, null],
			['hit three', 124, 1, null],
			['miss two', null, 0, 'no match'],
		]);
	});

	it('stops after 5 consecutive failures with an honest note', async () => {
		const t = toolsWithBeatport(() => { throw new Error('beatport temporarily blocked'); });
		await loadCandidates(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
		const res = await t.get('map_tool_over_table')!.execute({
			table: 'candidates',
			tool: 'lookup_beatport',
			args: { title: '$title', artists: '$artists[]' },
			into: 'bp',
		}, ctx) as { mapped: number; ok: number; note: string };
		expect(res.mapped).toBe(5);
		expect(res.ok).toBe(0);
		expect(res.note).toContain('STOPPED after 5 consecutive failures');
	});

	it('rejects non-mappable tools and unknown column bindings', async () => {
		const t = toolsWithBeatport(() => ({}));
		await loadCandidates(['x']);
		await expect(t.get('map_tool_over_table')!.execute({
			table: 'candidates', tool: 'present_result_set', args: {}, into: 'out',
		}, ctx)).rejects.toThrow(/must be one of/);
		await expect(t.get('map_tool_over_table')!.execute({
			table: 'candidates', tool: 'lookup_beatport', args: { title: '$nope' }, into: 'out',
		}, ctx)).rejects.toThrow(/column "nope" is not in candidates/);
	});

	it('SECURITY: provider hits recorded mid-map stay presentable in a later turn; fabricated ids do not', async () => {
		const t = toolsWithBeatport((target) => ({
			id: 42, url: 'https://beatport.test/42', title: target.title, mix: null, isrc: null,
			duration: null, bpm: 124, key: null, genre: null, label: null, artists: target.artists, release_date: null,
		}));
		await loadCandidates(['hit one']);
		// The real lookup_beatport records providerHits itself — our scripted
		// client bypasses that path, so exercise the mirror the way the inner
		// tool would: via the ctx the map hands it. Easiest faithful check:
		// run the REAL lookup_beatport through the map (it calls
		// ctx.providerHits.record on a found track).
		await t.get('map_tool_over_table')!.execute({
			table: 'candidates', tool: 'lookup_beatport',
			args: { title: '$title', artists: '$artists[]' }, into: 'bp',
		}, ctx);
		// "Later turn": fresh turn cache; only the session cache carries the id.
		const laterTurnHits = new CompositeProviderHits([new ProviderHitCache(), ctx.workspace!.sessionProviderHits]);
		const drafts = [
			{ kind: 'provider-hit' as const, title: 'T', artists: ['A'], providerRef: { provider: 'beatport' as const, id: '42' } },
			{ kind: 'provider-hit' as const, title: 'F', artists: ['A'], providerRef: { provider: 'beatport' as const, id: 'forged-99' } },
		];
		const { accepted, rejected } = await validateResultItems(drafts, REFS, laterTurnHits);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]!.providerRef).toMatchObject({ id: '42', url: 'https://beatport.test/42' });
		expect(rejected).toEqual([{ index: 1, reason: expect.stringContaining('not returned by any tool call') }]);
	});
});

// ─── Play-history tools ───────────────────────────────────────────────────
// Arg parsing + result shaping over a faked service — the SQL itself is
// covered in plays/plays.test.ts.
describe('play-history tools', () => {
	const calls: Record<string, unknown[]> = {};
	const svc = {
		async getTrackPlayHistory(trackId: string, opts: unknown) {
			calls['history'] = [trackId, opts];
			return {
				total: 1,
				rows: [{
					id: 'p1', playedAt: Date.parse('2026-08-14T10:00:00Z'), source: 'rekordbox',
					sessionId: 's1', sessionName: 'HISTORY 2026-08-14', sessionKind: 'set',
					playedMs: null, played75: null, endedReason: null, contextType: null, contextId: null,
				}],
			};
		},
		async listPlaySessions(opts: unknown) {
			calls['sessions'] = [opts];
			return [{
				id: 's1', origin: 'rekordbox', kind: 'set', kindSource: 'auto', name: 'HISTORY 2026-08-14',
				startedAt: new Date('2026-08-14'), endedAt: null, rbHistoryId: 'H1',
				createdAt: new Date(), updatedAt: new Date(), playCount: 12,
			}];
		},
		async getPlaySession(sessionId: string) {
			calls['session'] = [sessionId];
			return {
				session: {
					id: sessionId, origin: 'curator', kind: 'prep', kindSource: 'auto', name: null,
					startedAt: new Date('2026-08-14'), endedAt: null, rbHistoryId: null,
					createdAt: new Date(), updatedAt: new Date(),
				},
				plays: [
					{ pos: 1, trackId: 't1', rbContentId: null, title: 'One', artists: [{ name: 'A' }], playedAt: null, playedMs: 60_000, played75: true, source: 'local' },
					{ pos: 2, trackId: null, rbContentId: 'C9', title: null, artists: null, playedAt: null, playedMs: null, played75: null, source: 'rekordbox' },
				],
			};
		},
		async getTopPlayed(opts: unknown) {
			calls['top'] = [opts];
			return [{ trackId: 't1', title: 'One', artists: [{ name: 'A' }], plays: 7, lastPlayedAt: Date.parse('2026-08-14T10:00:00Z') }];
		},
	} as unknown as CoreService;
	const tools = new Map(buildAgentTools({
		svc: () => svc,
		getSpotifyClient: async () => null,
		beatport: null,
		waitForKbExpansion: async () => false,
	}).map((t) => [t.name, t]));
	const ctx = {} as AgentToolCtx;

	it('get_play_history requires trackId and shapes rows with session context', async () => {
		await expect(tools.get('get_play_history')!.execute({}, ctx)).rejects.toThrow(/trackId/);
		const res = await tools.get('get_play_history')!.execute({ trackId: 't1', limit: 500 }, ctx) as { total: number; plays: Record<string, unknown>[] };
		expect(calls['history']).toEqual(['t1', { limit: 100, offset: 0 }]); // clamped
		expect(res.total).toBe(1);
		expect(res.plays[0]).toMatchObject({ sessionKind: 'set', source: 'rekordbox', playedSec: null });
		expect(res.plays[0]!['playedAt']).toBe('2026-08-14T10:00:00.000Z');
	});

	it('list_play_sessions converts ISO date filters to ms', async () => {
		const res = await tools.get('list_play_sessions')!.execute(
			{ origin: 'rekordbox', kind: 'set', fromDate: '2026-01-01', toDate: 'not-a-date' }, ctx,
		) as { sessions: Record<string, unknown>[] };
		const opts = (calls['sessions'] as [Record<string, unknown>])[0];
		expect(opts).toMatchObject({ origin: 'rekordbox', kind: 'set', fromMs: Date.parse('2026-01-01') });
		expect('toMs' in opts).toBe(false); // unparseable date dropped
		expect(res.sessions[0]).toMatchObject({ kind: 'set', playCount: 12 });
	});

	it('get_play_session surfaces rbContentId only for unlinked plays', async () => {
		const res = await tools.get('get_play_session')!.execute({ sessionId: 's1' }, ctx) as { found: boolean; plays: Record<string, unknown>[] };
		expect(res.found).toBe(true);
		expect(res.plays[0]).toMatchObject({ trackId: 't1', artists: 'A', playedSec: 60 });
		expect('rbContentId' in res.plays[0]!).toBe(false);
		expect(res.plays[1]).toMatchObject({ trackId: null, rbContentId: 'C9' });
	});

	it('get_top_played shapes aggregates', async () => {
		const res = await tools.get('get_top_played')!.execute({ origin: 'curator' }, ctx) as { tracks: Record<string, unknown>[] };
		expect(res.tracks[0]).toMatchObject({ trackId: 't1', plays: 7, artists: 'A' });
	});
});
