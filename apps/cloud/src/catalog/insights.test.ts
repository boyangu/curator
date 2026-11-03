// What the back office concludes about an object, kept on it: insights written and retired
// through the admin ops, carried across a merge, an edition naming its release wherever releases
// are listed — and a twins item approved with some pairs ruled not twins. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { browseObject } from './browse.js';
import { raise } from './inbox.js';
import { ingestClaims, linkReleasesToLabel } from './ingest.js';

type App = Awaited<ReturnType<typeof createTestApp>>;
const labelClaim = (name: string) => ({ provider: 'user' as const, kind: 'label' as const, providerId: `name:${name.toLowerCase()}`, name });
const release = (provider: 'spotify' | 'deezer' | 'bandcamp', id: string, title: string, date: string, tracks = 0) => ({
	provider,
	kind: 'release' as const,
	providerId: id,
	name: title,
	facts: { releaseDate: date },
	artists: [{ provider, kind: 'artist' as const, providerId: `${provider}-ivo-lark`, name: 'Ivo Lark' }],
	recordings: Array.from({ length: tracks }, (_, i) => ({ provider, kind: 'recording' as const, providerId: `${id}-t${i + 1}`, name: `${title} ${i + 1}` })),
});

// A label with these releases (each its own object: different stores, dates a week apart).
async function labelWith(app: App, claims: ReturnType<typeof release>[]): Promise<{ label: string; ids: string[] }> {
	return withSystemTx(app.db, async (tx) => {
		const [l] = (await ingestClaims(tx, [labelClaim('Northfold')], { reason: 'library_import' })).outcomes;
		const out = await ingestClaims(tx, claims, { reason: 'tracker' });
		await linkReleasesToLabel(tx, l!.objectId, out.outcomes.map((o, i) => ({ objectId: o.objectId, claim: claims[i]! })));
		return { label: l!.objectId, ids: out.outcomes.map((o) => o.objectId) };
	});
}
const mergedInto = async (app: App, id: string) => (await app.db.query<{ merged_into: string | null }>(`select merged_into from curator.catalog_object where id = $1`, [id]))[0]!.merged_into;

describe('insights', () => {
	it('keeps what was concluded on the object, carries it across a merge, and labels an edition in the release lists', async () => {
		const app = await createTestApp();
		const { label, ids } = await labelWith(app, [release('spotify', 's1', 'Big Fun', '2026-10-23', 6), release('bandcamp', 'b1', 'Big Fun', '2026-10-30', 1), release('spotify', 's2', 'Metaflora', '2026-10-08', 3)]);
		const [keep, fold, edition] = ids as [string, string, string];
		const ops = adminOps(app.db, {});
		await ops.insightAdd({ q: fold, topic: 'partial', body: 'Bandcamp listing is partial (1 of 6 tracks)' });
		await ops.insightAdd({ q: edition, topic: 'Edition', body: 'Spotify / Tidal / Bandcamp, 30 tracks' });
		await expect(ops.insightAdd({ q: keep, topic: 'two words', body: 'x' })).rejects.toThrow(/topic/);
		// Logged, each with its undo.
		const logged = (await ops.inboxList({ status: 'all', kind: 'insight.add' })).rows;
		expect(logged).toHaveLength(2);
		expect(logged[0]!.undo).toMatchObject({ op: 'retireInsight' });

		// The merge keeps the survivor's view of the release whole; a note
		// added by the loser's id afterwards lands on the survivor too.
		await withSystemTx(app.db, async (tx) => {
			const { mergeObjects } = await import('./admin.js');
			await mergeObjects(tx, fold, keep, 'test', 'twins');
		});
		expect(await mergedInto(app, fold)).toBe(keep);
		await ops.insightAdd({ q: fold, topic: 'note', body: 'merged from the Bandcamp copy' });
		const list = await ops.insightList({ q: keep });
		expect(list.insights.map((i) => [i.topic, i.body])).toEqual([
			['partial', 'Bandcamp listing is partial (1 of 6 tracks)'],
			['note', 'merged from the Bandcamp copy'],
		]);

		// The edition labels its release in the label's lists (CLI and back office) and on its page.
		const releases = await ops.labelReleases({ q: label });
		expect(releases.find((r) => r.id === edition)).toMatchObject({ edition: 'Spotify / Tidal / Bandcamp, 30 tracks' });
		expect(releases.find((r) => r.id === keep)!.edition).toBeUndefined();
		const view = await withSystemTx(app.db, (tx) => browseObject(tx, label));
		expect(view!.releases!.find((r) => r.id === edition)).toMatchObject({ edition: 'Spotify / Tidal / Bandcamp, 30 tracks' });
		expect((await withSystemTx(app.db, (tx) => browseObject(tx, keep)))!.insights).toHaveLength(2);

		// Retired: off the views, kept on the record, back with the undo.
		const [partial] = list.insights;
		await ops.insightRetire({ id: partial!.id, note: 'Bandcamp now lists all six' });
		expect((await ops.insightList({ q: keep })).insights).toHaveLength(1);
		expect((await ops.insightList({ q: keep, retired: true })).insights.find((i) => i.id === partial!.id)).toMatchObject({ retiredBy: 'claude-code' });
		await expect(ops.insightRetire({ id: partial!.id })).rejects.toThrow(/already retired/);
	});

	it('is undone from the inbox when it was surfaced (a followed label)', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: labelClaim('Northfold'), source: 'manual' });
		const ops = adminOps(app.db, {});
		await ops.insightAdd({ q: 'Northfold', topic: 'note', body: 'distributes Spirit Dance releases' });
		const [item] = (await ops.inboxList({ status: 'open', kind: 'insight.add' })).rows;
		expect(item).toMatchObject({ severity: 'notice', subjectNames: [{ name: 'Northfold' }] });
		await ops.inboxDecide({ id: item!.id, action: 'reject', by: 'guy' });
		expect((await ops.insightList({ q: w.watch.object.id })).insights).toEqual([]);
	});
});

describe('twins approved in part', () => {
	it('merges the ticked pairs and rules the excepted ones not twins', async () => {
		const app = await createTestApp();
		const { label, ids } = await labelWith(app, [
			release('spotify', 's1', 'Glass Rivers', '2026-03-01', 2),
			release('bandcamp', 'b1', 'Glass Rivers', '2026-03-08'),
			release('spotify', 's2', 'Say Hello', '2026-03-01', 1),
			release('deezer', 'd2', 'Say Hello', '2026-03-15', 1),
		]);
		const [k0, f0, k1, f1] = ids as [string, string, string, string];
		const id = await withSystemTx(app.db, (tx) =>
			raise(tx, { kind: 'release.twins', severity: 'approval', title: '2 twin releases', subjects: [label], evidence: {}, apply: { op: 'mergeReleases', args: { pairs: [{ keep: k0, fold: f0 }, { keep: k1, fold: f1 }] } }, actor: 'worker' }),
		);
		const ops = adminOps(app.db, {});
		await expect(ops.inboxDecide({ id: id!, action: 'approve', except: [2], by: 'guy' })).rejects.toThrow(/no pair 2/);
		await expect(ops.inboxDecide({ id: id!, action: 'reject', except: [1], by: 'guy' })).rejects.toThrow(/--except/);
		const r = await ops.inboxDecide({ id: id!, action: 'approve', except: [1], note: 'Say Hello: two releases', by: 'guy' });
		expect(r).toMatchObject({ status: 'approved', resolution: 'applied except pair 1 (not twins)' });
		expect(await mergedInto(app, f0)).toBe(k0);
		expect(await mergedInto(app, f1)).toBeNull();
		const [x, y] = [k1, f1].sort();
		expect(await app.db.query(`select reason from curator.catalog_not_same where object_a = $1 and object_b = $2`, [x!, y!])).toEqual([{ reason: 'Say Hello: two releases' }]);
	});
});
