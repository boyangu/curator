// CoreService integration: similarity through the same getTracksPage path the
// renderer uses, with vectors already in mir.db and NO engine spec (disabled
// is a supported state — seed similarity still answers from stored vectors).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import { SqliteMirStore } from './store.js';
import { removeDir } from '../test-support/tmp.js';

const M = 'mert-v2-fullsong@1';
const vec = (xs: number[]): Buffer => Buffer.from(new Float32Array(xs).buffer);

let dir: string;
let svc: CoreService;
let mir: SqliteMirStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-mir-svc-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	const raw = new Database(dbPath);
	const tracks: [string, number][] = [['a', 120], ['b', 122], ['c', 126], ['d', 128], ['e', 130]];
	for (const [id, bpm] of tracks) {
		raw.prepare(`INSERT INTO track (id, title, artists, duration, state, bpm) VALUES (?, ?, '[]', 300, 'unsorted', ?)`).run(id, `T-${id}`, bpm);
		raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`)
			.run(`sl-${id}`, id, `x:/nowhere/${id}.flac`, `x:/nowhere/${id}.flac`);
	}
	raw.close();
	mir = new SqliteMirStore(join(dir, 'mir.db'));
	mir.upsertModel({ key: 'mert-v2-fullsong', modelId: M, dim: 2, sampleRate: 24000, text: false, license: '', repo: '', summary: '' });
	// Angles from a: b closest, then c, then d; e has no vector.
	mir.putResult('a', M, 'local', null, vec([1, 0]), []);
	mir.putResult('b', M, 'local', null, vec([0.95, 0.31]), []);
	mir.putResult('c', M, 'local', null, vec([0.7, 0.7]), []);
	mir.putResult('d', M, 'local', null, vec([0, 1]), []);
	svc = createCoreService(dbPath);
});
afterEach(async () => {
	// Awaited: the service's own mir.db handle closes after close() returns.
	await svc.close();
	mir.close();
	await removeDir(dir);
});

describe('similarTo through getTracksPage', () => {
	it('ranks best-first with matchScore and excludes the seed', async () => {
		const page = await svc.getTracksPage({ similarTo: { seeds: ['a'] } });
		expect(page.items.map((t) => t.id)).toEqual(['b', 'c', 'd']);
		expect(page.total).toBe(3);
		expect(page.items[0]!.matchScore).toBeGreaterThan(page.items[1]!.matchScore!);
	});

	it('ranks inside the scope instead of filtering a global top-k', async () => {
		const page = await svc.getTracksPage({ similarTo: { seeds: ['a'], k: 1 }, bpmMin: 125 });
		expect(page.items.map((t) => t.id)).toEqual(['c']);
	});

	it('honours an explicit column sort and paging', async () => {
		const page = await svc.getTracksPage({ similarTo: { seeds: ['a'] } }, { column: 'bpm', dir: 'desc' }, { limit: 2 });
		expect(page.items.map((t) => t.id)).toEqual(['d', 'c']);
		expect(page.total).toBe(3);
		expect(await svc.getTrackIds({ similarTo: { seeds: ['a'] } }, { column: 'match', dir: 'desc' })).toEqual(['b', 'c', 'd']);
	});

	it('a seed with no vector yields an empty scope, never the whole library', async () => {
		const page = await svc.getTracksPage({ similarTo: { seeds: ['e'] } });
		expect(page).toEqual({ items: [], total: 0, nextCursor: null });
		const r = await svc.getSimilarTracks({ seeds: ['e'] });
		expect(r.missingSeeds).toEqual(['e']);
	});

	it('deleting a track drops its vectors from results', async () => {
		await svc.deleteTracks(['b']);
		expect(mir.trackVector('b', M)).toBeNull();
		const r = await svc.getSimilarTracks({ seeds: ['a'], k: 5 });
		expect(r.items.map((i) => i.trackId)).toEqual(['c', 'd']);
	});

	it('seed queries blend every enabled model; an explicit model ranks alone', async () => {
		const Q = 'muq-mulan-large@1';
		mir.upsertModel({ key: 'muq-mulan-large', modelId: Q, dim: 2, sampleRate: 24000, text: true, license: '', repo: '', summary: '' });
		// The second model hears it differently: d is a's closest relative.
		mir.putResult('a', Q, 'local', null, vec([1, 0]), []);
		mir.putResult('b', Q, 'local', null, vec([0, 1]), []);
		mir.putResult('c', Q, 'local', null, vec([-1, 0.2]), []);
		mir.putResult('d', Q, 'local', null, vec([0.99, 0.05]), []);
		await svc.setMirSettings({ models: ['mert-v2-fullsong', 'muq-mulan-large'] });
		const blended = await svc.getSimilarTracks({ seeds: ['a'], k: 3 });
		expect(blended.model).toBe(`${M}+${Q}`);
		const alone = await svc.getSimilarTracks({ seeds: ['a'], k: 3, model: 'mert-v2-fullsong' });
		expect(alone.model).toBe(M);
		expect(alone.items[0]!.trackId).toBe('b');
		// MuQ hears b as unlike a, so the blend pulls b's score well below MERT's alone.
		expect(blended.items.find((i) => i.trackId === 'b')!.score).toBeLessThan(alone.items[0]!.score - 0.3);
	});

	it('reports disabled status with coverage from stored vectors', async () => {
		const st = await svc.mirStatus();
		expect(st.state).toBe('disabled');
		expect(st.coverage.perModel[M]).toEqual({ done: 4, failed: 0 });
		expect(st.coverage.localTracks).toBe(5);
		await expect(svc.mirAnalyzeNow(['a'])).rejects.toThrow(/not installed/);
		const s2 = await svc.setMirSettings({ enabled: true, models: ['clap'] });
		expect(s2.settings).toEqual({ enabled: true, executor: 'local', models: ['clap'] });
	});
});
