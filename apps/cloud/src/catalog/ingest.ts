// The one way anything enters the catalogue. A producer (a tracker, a device's
// import, a manual registration) hands claims; each is resolved against the
// catalogue's own objects (identity.ts) and only what is missing is created.
// Ingesting the same claims twice changes nothing the second time.
//
// What ingestion writes, per claim:
//   - the object, when no existing one is the claim's (discovered_at = now,
//     discovered_via = the reason it arrived);
//   - the provider's representation of it, and its global identifiers;
//   - the source's facts, once per (field, source); the object's attributes
//     take them only while empty for a static object (fold.ts);
//   - its relationships (credited artists, tracklist, label, genres), each a
//     canonical edge with this source's evidence beside it;
//   - the gaps the planner should fill (catalog_enrich_task).
// What it never does: raise an event. Events are a tracker's call
// (events.ts), made after its ingest committed, and only for recent children
// of the object it tracks; imports and registrations populate silently.

import {
	isLiveKind,
	type CatalogClaim,
	type CatalogIngestReason,
	type CatalogKind,
	type CatalogProvider,
} from '@curator/protocol';
import { nameFold, recordingKey } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { foldAttrs, releaseAtOf, type FactRow } from './fold.js';
import {
	type ClaimParent,
	corroborated,
	findByIdentifier,
	findRepresentation,
	NAMESPACE_KIND,
	normalizeIdentifier,
	recordingByIsrcOk,
	recordingByKey,
	releaseByTitle,
} from './identity.js';
import { ensureCursors } from './watches.js';

export type IngestContext = { reason: CatalogIngestReason };

export type IngestOutcome = { objectId: string; kind: CatalogKind; created: boolean };

const str = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : String(n));

export class Ingester {
	readonly stats = { created: 0, attached: 0 };
	// One resolution per (provider, kind, id) per ingest: a tracklist naming
	// the same artist twelve times resolves it once.
	private readonly memo = new Map<string, Promise<IngestOutcome>>();

	constructor(
		private readonly tx: Queryable,
		private readonly ctx: IngestContext,
	) {}

	// Attaches a claim to an object already decided (the planner confirmed it
	// by evidence ingestion cannot see): representation, identifiers, facts.
	async attachTo(objectId: string, c: CatalogClaim): Promise<void> {
		const rep = await this.attachRepresentation(c, objectId);
		await this.attachIdentifiers(c, objectId, rep.id);
		await this.attachFacts(c, objectId);
	}

	// Attaches a claim to the object it names only if the catalogue already has
	// one (by representation, identifier or the identity rules); nothing is
	// created and no relationship written. Null when it names nothing known.
	async attachIfKnown(c: CatalogClaim): Promise<IngestOutcome | null> {
		const objectId = (await findRepresentation(this.tx, c)) ?? (await this.candidate(c));
		if (!objectId) return null;
		const rep = await this.attachRepresentation(c, objectId);
		if (rep.inserted) this.stats.attached++;
		await this.attachIdentifiers(c, objectId, rep.id);
		await this.attachFacts(c, objectId);
		return { objectId, kind: c.kind, created: false };
	}

	claim(c: CatalogClaim, parent?: ClaimParent): Promise<IngestOutcome> {
		const key = `${c.provider}|${c.kind}|${c.providerId}`;
		let p = this.memo.get(key);
		if (!p) {
			p = this.blocked(c).then((weak) => this.resolve(weak, parent));
			this.memo.set(key, p);
		}
		return p;
	}

	// What the reasoner or the operator ruled about credits and store ids
	// (catalog_credit_rule, catalog_source_block; migration 0024), read once
	// per ingest. Both tables are small.
	private rulesMemo: Promise<{ credits: Map<string, { name: string; kind: 'compound' | 'split'; pieces: string[] }>; blocked: Set<string> }> | null = null;
	private rules() {
		this.rulesMemo ??= (async () => {
			const credits = new Map<string, { name: string; kind: 'compound' | 'split'; pieces: string[] }>();
			for (const r of await this.tx.query<{ name_fold: string; name: string; kind: 'compound' | 'split'; pieces: string }>(`select name_fold, name, kind, pieces::text as pieces from curator.catalog_credit_rule`)) {
				credits.set(r.name_fold, { name: r.name, kind: r.kind, pieces: r.pieces === '{}' ? [] : r.pieces.slice(1, -1).split(',').map((p) => p.replace(/^"|"$/g, '')) });
			}
			const blocked = new Set((await this.tx.query<{ k: string }>(`select provider || '|' || kind || '|' || provider_id as k from curator.catalog_source_block`)).map((r) => r.k));
			return { credits, blocked };
		})();
		return this.rulesMemo;
	}

	// A claim under a blocked store id (a profile that is a bucket of
	// namesakes) is read as a name only: a weak key the identity rules join
	// through the release it arrives with, never the store's word on identity.
	private async blocked(c: CatalogClaim): Promise<CatalogClaim> {
		if (c.provider === 'user') return c;
		const { blocked } = await this.rules();
		if (!blocked.has(`${c.provider}|${c.kind}|${c.providerId}`)) return c;
		return { ...c, provider: 'user', providerId: `name:${nameFold(c.name)}`, url: null, identifiers: [] };
	}

	// Credits the catalogue ruled on: a compound rule's pieces, claimed
	// together, become the one act under the rule's name (a weak key, so the
	// act's existing object is joined); a split rule's name becomes its pieces.
	private async creditRules(artists: CatalogClaim[]): Promise<CatalogClaim[]> {
		if (artists.length === 0) return artists;
		const { credits } = await this.rules();
		if (credits.size === 0) return artists;
		const weak = (name: string): CatalogClaim => ({ provider: 'user', kind: 'artist', providerId: `name:${nameFold(name)}`, name });
		let out = artists.flatMap((a) => {
			const rule = credits.get(nameFold(a.name));
			return rule && rule.kind === 'split' && rule.pieces.length >= 2 ? rule.pieces.map((p) => weak(p)) : [a];
		});
		const folds = new Set(out.map((a) => nameFold(a.name)));
		for (const [, rule] of credits) {
			if (rule.kind !== 'compound' || rule.pieces.length < 2) continue;
			const pieceFolds = rule.pieces.map((p) => nameFold(p));
			if (!pieceFolds.every((f) => folds.has(f))) continue;
			out = [weak(rule.name), ...out.filter((a) => !pieceFolds.includes(nameFold(a.name)))];
			for (const f of pieceFolds) folds.delete(f);
		}
		return out;
	}

	private async resolve(c: CatalogClaim, parent?: ClaimParent): Promise<IngestOutcome> {
		let objectId = await findRepresentation(this.tx, c);
		let created = false;
		if (!objectId) objectId = await this.candidate(c, parent);
		if (!objectId) {
			objectId = await this.create(c);
			created = true;
			this.stats.created++;
		}
		const repNew = await this.attachRepresentation(c, objectId);
		if (!created && repNew.inserted) {
			this.stats.attached++;
			// A watched object reachable on one more provider gains that
			// provider's tracker.
			if (isLiveKind(c.kind)) await ensureCursors(this.tx, objectId);
		}
		await this.attachIdentifiers(c, objectId, repNew.id);
		await this.attachFacts(c, objectId);
		await this.attachRelationships(c, objectId, repNew.id, parent);
		if (created) await this.recordGaps(c, objectId);
		return { objectId, kind: c.kind, created };
	}

	// An existing object this claim is about, by the rules of identity.ts.
	private async candidate(c: CatalogClaim, parent?: ClaimParent): Promise<string | null> {
		const byId = await findByIdentifier(this.tx, c);
		if (byId) {
			if (byId.namespace !== 'isrc' || (await recordingByIsrcOk(this.tx, byId.id, c.facts?.durationSec))) return byId.id;
		}
		const fold = nameFold(c.name);
		switch (c.kind) {
			case 'recording':
				return recordingByKey(this.tx, recordingKey(c.name, (c.artists ?? []).map((a) => a.name)), c.facts?.durationSec);
			case 'release':
				// By credited names, before any artist is resolved: the artists
				// then corroborate through the release found (attachRelationships).
				return releaseByTitle(
					this.tx,
					fold,
					(c.artists ?? []).map((a) => nameFold(a.name)).filter(Boolean),
					releaseAtOf(c.facts?.releaseDate),
				);
			case 'artist':
			case 'label':
				return parent ? corroborated(this.tx, c.kind, fold, parent, c.provider) : null;
			default:
				return null;
		}
	}

	private async create(c: CatalogClaim): Promise<string> {
		const f = c.facts ?? {};
		const recKey = c.kind === 'recording' ? recordingKey(c.name, (c.artists ?? []).map((a) => a.name)) : null;
		const releaseAt = c.kind === 'release' ? releaseAtOf(f.releaseDate) : null;
		const [row] = await this.tx.query<{ id: string }>(
			`insert into curator.catalog_object
				(kind, name, name_fold, discovered_via, duration_sec, rec_key, release_at, release_type, label_text, home_provider)
			values ($1, $2, $3, $4, $5::float8, $6, to_timestamp($7::float8 / 1000), $8, $9, $10)
			returning id`,
			[
				c.kind,
				c.name,
				nameFold(c.name),
				this.ctx.reason,
				c.kind === 'recording' ? str(f.durationSec) : null,
				recKey,
				str(releaseAt),
				c.kind === 'release' ? (f.releaseType ?? null) : null,
				c.kind === 'release' ? (f.labelText ?? null) : null,
				c.kind === 'playlist' ? c.provider : null,
			],
		);
		// A new label may be one the catalogue holds under another name: checked
		// now and while its releases arrive (label-related.ts).
		if (c.kind === 'label') await this.tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'dedupe', 'catalog') on conflict do nothing`, [row!.id]);
		return row!.id;
	}

	private async attachRepresentation(c: CatalogClaim, objectId: string): Promise<{ id: string; inserted: boolean }> {
		const [row] = await this.tx.query<{ id: string; inserted: boolean }>(
			`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url, payload)
			values ($1, $2, $3, $4, $5, $6::text::jsonb)
			on conflict (provider, kind, provider_id) do update set last_seen_at = now(),
				url = coalesce(excluded.url, curator.catalog_source_object.url)
			returning id, (xmax = 0) as inserted`,
			[objectId, c.provider, c.kind, c.providerId, c.url ?? null, JSON.stringify({ name: c.name, ...(c.facts ? { facts: c.facts } : {}) })],
		);
		return { id: row!.id, inserted: row!.inserted === true };
	}

	// Identifiers of the wrong kind, malformed, or already naming another
	// object are dropped: an ISRC on two recordings is a provider's error the
	// catalogue does not copy.
	private async attachIdentifiers(c: CatalogClaim, objectId: string, sourceObjectId: string): Promise<void> {
		for (const ident of c.identifiers ?? []) {
			if (NAMESPACE_KIND[ident.namespace] !== c.kind) continue;
			const value = normalizeIdentifier(ident.namespace, ident.value);
			if (!value) continue;
			await this.tx.query(
				`insert into curator.catalog_identifier (namespace, value, object_id, source_object_id) values ($1, $2, $3, $4) on conflict do nothing`,
				[ident.namespace, value, objectId, sourceObjectId],
			);
		}
	}

	private async attachFacts(c: CatalogClaim, objectId: string): Promise<void> {
		const live = isLiveKind(c.kind);
		const facts: FactRow[] = Object.entries(c.facts ?? {})
			.filter(([, v]) => v !== undefined && v !== null)
			.map(([field, value]) => ({ field, source: c.provider, value }));
		for (const f of facts) {
			// Static: the first value a source gave is the one kept. Live: the
			// source's current value replaces its previous one.
			await this.tx.query(
				`insert into curator.catalog_fact (object_id, field, source, value) values ($1, $2, $3, $4::text::jsonb)
				on conflict (object_id, field, source) do ${live ? 'update set value = excluded.value, at = now()' : 'nothing'}`,
				[objectId, f.field, f.source, JSON.stringify(f.value)],
			);
		}
		const [row] = await this.tx.query<{ attrs: unknown; name: string }>(`select attrs::text as attrs, name from curator.catalog_object where id = $1`, [objectId]);
		const current = JSON.parse(String(row!.attrs)) as Record<string, unknown>;
		const next = foldAttrs(current, facts, { live, liveSource: c.provider });
		const rename = live && c.name !== row!.name;
		if (JSON.stringify(next) === JSON.stringify(current) && !rename) return;
		const f = c.facts ?? {};
		await this.tx.query(
			`update curator.catalog_object set attrs = $2::text::jsonb, updated_at = now(),
				name = case when $3 then $4 else name end,
				name_fold = case when $3 then $5 else name_fold end,
				duration_sec = coalesce(duration_sec, $6::float8),
				release_at = coalesce(release_at, to_timestamp($7::float8 / 1000)),
				release_type = coalesce(release_type, $8),
				label_text = coalesce(label_text, $9)
			where id = $1`,
			[
				objectId,
				JSON.stringify(next),
				rename ? 'true' : 'false',
				c.name,
				nameFold(c.name),
				c.kind === 'recording' ? str(f.durationSec) : null,
				c.kind === 'release' ? str(releaseAtOf(f.releaseDate)) : null,
				c.kind === 'release' ? (f.releaseType ?? null) : null,
				c.kind === 'release' ? (f.labelText ?? null) : null,
			],
		);
	}

	private async attachRelationships(c: CatalogClaim, objectId: string, sourceObjectId: string, parent?: ClaimParent): Promise<void> {
		// A track's credits know the release they arrive in: the release's own
		// credits are written before its tracklist, so they corroborate the
		// track's (a store's track-level copy of the release artist).
		const self: ClaimParent = { id: objectId, kind: c.kind, release: c.kind === 'recording' && parent?.kind === 'release' ? parent.id : undefined };
		if (c.kind === 'release') {
			for (const [i, a] of (await this.creditRules(c.artists ?? [])).entries()) {
				const artist = await this.claim(a, self);
				if (artist.kind === 'artist') await this.edge(artist.objectId, 'artist-release', objectId, sourceObjectId, i === 0 ? 'main' : 'credited', i);
			}
			for (const [i, r] of (c.recordings ?? []).entries()) {
				// A tracklist entry without its own credits carries the release's.
				const rec = await this.claim({ ...r, artists: r.artists?.length ? r.artists : c.artists }, self);
				if (rec.kind === 'recording') await this.edge(objectId, 'release-recording', rec.objectId, sourceObjectId, null, r.facts?.trackNumber ?? i + 1);
			}
			if (c.label) {
				const label = await this.claim(c.label, self);
				if (label.kind === 'label') await this.edge(objectId, 'release-label', label.objectId, sourceObjectId, null, null);
			}
		}
		if (c.kind === 'recording') {
			for (const [i, a] of (await this.creditRules(c.artists ?? [])).entries()) {
				const artist = await this.claim(a, self);
				if (artist.kind === 'artist') await this.edge(objectId, 'recording-artist', artist.objectId, sourceObjectId, i === 0 ? 'main' : 'credited', i);
			}
		}
		// A label's roster, as the provider lists it (Bandcamp's artists page).
		if (c.kind === 'label') {
			for (const [i, a] of (c.artists ?? []).entries()) {
				const artist = await this.claim(a, self);
				if (artist.kind === 'artist') await this.edge(objectId, 'label-artist', artist.objectId, sourceObjectId, null, i);
			}
		}
		if (c.genres?.length) await this.attachGenres(c.provider, c.genres, objectId, sourceObjectId);
	}

	// Onto the canonical taxonomy where an alias says so; an unknown string is
	// recorded as unmapped (an operator maps it or leaves it orthogonal) and
	// kept as the source's 'genres' fact.
	private async attachGenres(provider: CatalogProvider, genres: string[], objectId: string, sourceObjectId: string): Promise<void> {
		await this.tx.query(
			`insert into curator.catalog_fact (object_id, field, source, value) values ($1, 'genres', $2, $3::text::jsonb) on conflict do nothing`,
			[objectId, provider, JSON.stringify(genres)],
		);
		for (const raw of genres) {
			const fold = nameFold(raw);
			if (!fold) continue;
			const [alias] = await this.tx.query<{ genre_id: string | null }>(
				`with ins as (insert into curator.genre_alias (provider, raw_fold, genre_id) values ($1, $2, null) on conflict do nothing returning genre_id)
				select genre_id from curator.genre_alias where provider = $1 and raw_fold = $2`,
				[provider, fold],
			);
			if (alias?.genre_id) await this.edge(objectId, 'object-genre', alias.genre_id, sourceObjectId, null, null);
		}
	}

	private edge(src: string, kind: string, dst: string, sourceObjectId: string, role: string | null, position: number | null): Promise<void> {
		return addEdge(this.tx, src, kind, dst, sourceObjectId, role, position);
	}

	// What a new static object is missing that another provider can supply.
	private async recordGaps(c: CatalogClaim, objectId: string): Promise<void> {
		const has = (ns: string) => (c.identifiers ?? []).some((i) => i.namespace === ns);
		const gaps: [string, string][] = [];
		if (c.kind === 'recording' && !has('isrc')) gaps.push(['isrc', 'deezer']);
		// A tracker's new track from elsewhere: Discover needs its Spotify id
		// (planner.ts runRecordingResolver); so does a library's own track, which
		// the catalogue then links to the store copies. Other imports populate
		// silently.
		if (c.kind === 'recording' && has('isrc') && c.provider !== 'spotify' && (this.ctx.reason === 'tracker' || this.ctx.reason === 'library_import')) gaps.push(['representation', 'spotify']);
		if (c.kind === 'release' && !has('upc')) gaps.push(['upc', 'deezer']);
		if (c.kind === 'release' && !c.label && !c.facts?.labelText) gaps.push(['label', 'deezer']);
		for (const [need, provider] of gaps) {
			await this.tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, $2, $3) on conflict do nothing`, [objectId, need, provider]);
		}
	}
}

// A canonical edge with one source's evidence beside it; the edge is made
// once, the evidence once per source.
export async function addEdge(tx: Queryable, src: string, kind: string, dst: string, sourceObjectId: string, role: string | null = null, position: number | null = null): Promise<void> {
	const [row] = await tx.query<{ id: string }>(
		`with ins as (
			insert into curator.catalog_edge (src, kind, dst, role, position) values ($1, $2, $3, $4, $5::int)
			on conflict (src, kind, dst) do nothing returning id
		)
		select id from ins union all select id from curator.catalog_edge where src = $1 and kind = $2 and dst = $3 limit 1`,
		[src, kind, dst, role, str(position)],
	);
	await tx.query(`insert into curator.catalog_edge_evidence (edge_id, source_object_id) values ($1, $2) on conflict do nothing`, [row!.id, sourceObjectId]);
}

// Releases a source lists as a label's (its catalogue playlist), tied to the
// label, each by its own representation's evidence: `release-label`.
export async function linkReleasesToLabel(tx: Queryable, labelId: string, releases: { objectId: string; claim: Pick<CatalogClaim, 'provider' | 'kind' | 'providerId'> }[]): Promise<number> {
	let linked = 0;
	for (const r of releases) {
		const [rep] = await tx.query<{ id: string }>(`select id from curator.catalog_source_object where provider = $1 and kind = $2 and provider_id = $3`, [r.claim.provider, r.claim.kind, r.claim.providerId]);
		if (!rep) continue;
		await addEdge(tx, r.objectId, 'release-label', labelId, rep.id);
		linked++;
	}
	return linked;
}

export async function ingestClaims(tx: Queryable, claims: CatalogClaim[], ctx: IngestContext): Promise<{ outcomes: IngestOutcome[]; created: number; attached: number }> {
	const ingester = new Ingester(tx, ctx);
	const outcomes: IngestOutcome[] = [];
	// In order, not in parallel: claims in one batch often share artists and
	// releases, and one transaction is one connection anyway.
	for (const c of claims) outcomes.push(await ingester.claim(c));
	return { outcomes, ...ingester.stats };
}
