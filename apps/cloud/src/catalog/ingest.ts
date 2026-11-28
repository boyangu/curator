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
//     canonical edge with this source's evidence beside it. A label a store
//     gives only as text is the label of that name (textLabel below);
//   - the gaps the planner should fill (catalog_enrich_task).
// A batch of claims is read and written as one: ingest-batch.ts holds what the
// claims name and queues what they decide, so a listing costs a handful of
// statements whatever its length. The rules here run over that, claim by
// claim and in order.
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
import { isDistributor, nameFold, recordingKey } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { isCreditStore, queueCredits } from './credits.js';
import { foldAttrs, releaseAtOf, type FactRow } from './fold.js';
import { type ClaimParent, NAMESPACE_KIND, normalizeIdentifier } from './identity.js';
import { type FlatClaim, IngestBatch, type Obj } from './ingest-batch.js';
import { slotMatch, type HeldTrack } from './slots.js';
import { ensureCursors } from './watches.js';

// `rules`: the credit rules and blocked store ids, when the caller read them
// already (loadIngestRules) — a report applying many releases reads them once.
export type IngestContext = { reason: CatalogIngestReason; rules?: IngestRules };

export type IngestRules = Promise<{ credits: Map<string, { name: string; kind: 'compound' | 'split'; pieces: string[] }>; blocked: Set<string> }>;

// What the reasoner or the operator ruled about credits and store ids
// (catalog_credit_rule, catalog_source_block; migration 0024). Both tables are small.
export function loadIngestRules(tx: Queryable): IngestRules {
	return (async () => {
		const credits = new Map<string, { name: string; kind: 'compound' | 'split'; pieces: string[] }>();
		const blocked = new Set<string>();
		for (const r of await tx.query<{ k: string; name: string | null; kind: 'compound' | 'split' | null; pieces: string | null }>(
			`select name_fold as k, name, kind, pieces::text as pieces from curator.catalog_credit_rule
			union all select provider || '|' || kind || '|' || provider_id, null, null, null from curator.catalog_source_block`,
		)) {
			if (r.kind === null) blocked.add(r.k);
			else credits.set(r.k, { name: r.name!, kind: r.kind, pieces: !r.pieces || r.pieces === '{}' ? [] : r.pieces.slice(1, -1).split(',').map((p) => p.replace(/^"|"$/g, '')) });
		}
		return { credits, blocked };
	})();
}

export type IngestOutcome = { objectId: string; kind: CatalogKind; created: boolean };

// Claims resolved together, nested ones counted: several listings' worth. Past
// it a batch is split, so no statement carries an unbounded parameter.
export const BATCH_NODES = 2000;

// A label stated as text (Spotify's and Deezer's albums, a device's
// finding) as a claim: the label of that name, keyed as a library's tag
// is (`user` / `name:<fold>`), so every way of writing a label down meets
// on one object and the label's followers get the release whichever store
// found it. A distributor's name is no label and stays text.
const textLabel = (text: unknown): CatalogClaim | null => {
	if (typeof text !== 'string' || isDistributor(text)) return null;
	return { provider: 'user', kind: 'label', providerId: `name:${nameFold(text)}`, name: text.trim() };
};
// A release claim's label: the store's own label object, else its text.
const labelOf = (c: CatalogClaim): CatalogClaim | null => c.label ?? textLabel(c.facts?.labelText);
const isNameKey = (c: Pick<CatalogClaim, 'provider' | 'providerId'>): boolean => c.provider === 'user' && c.providerId.startsWith('name:');
// Apple's lookup names one artist's id with the song's whole credit line
// (trackers/apple.ts): "MODBIT, Pay May & Sokko" on MODBIT's page. Not the
// page's own name, so like a name key it names a new object and renames none
// (2026-11-28: such claims had renamed some 2,200 real artists;
// compound-artists.ts finds them, `catalog repair compound-artists` renames
// them back).
const isCreditLine = (c: Pick<CatalogClaim, 'provider' | 'kind'>): boolean => c.provider === 'apple' && c.kind === 'artist';

export class Ingester {
	readonly stats = { created: 0, attached: 0 };
	// One resolution per (provider, kind, id) per ingest: a tracklist naming
	// the same artist twelve times resolves it once.
	private readonly memo = new Map<string, Promise<IngestOutcome>>();

	constructor(
		private readonly tx: Queryable,
		private readonly ctx: IngestContext,
	) {}

	// Every call below runs in a batch: its own, or the caller's (`batch`,
	// around several calls). What the batch queued is written when it ends, so
	// a caller reading the catalogue between two calls must not share one.
	private b: IngestBatch | null = null;
	// Releases whose track credits may be short, and watched objects that may
	// gain a tracker: both read what the batch wrote, so they follow it.
	private readonly credits = new Set<string>();
	private readonly cursors = new Set<string>();

	async batch<T>(claims: readonly CatalogClaim[], fn: () => Promise<T>, objectIds: readonly string[] = []): Promise<T> {
		if (this.b) return fn();
		const b = new IngestBatch(this.tx, this.ctx.reason);
		const flat: FlatClaim[] = [];
		for (const c of claims) await this.flatten(c, null, flat);
		await b.prefetch(flat, objectIds);
		this.b = b;
		try {
			const out = await fn();
			await b.flush();
			if (this.cursors.size) await ensureCursors(this.tx, [...this.cursors].sort());
			if (this.credits.size) await queueCredits(this.tx, [...this.credits].sort());
			return out;
		} finally {
			this.b = null;
			this.cursors.clear();
			this.credits.clear();
		}
	}

	// The claims a claim will resolve, as it will resolve them: what the batch
	// reads for.
	private async flatten(c: CatalogClaim, parent: CatalogClaim | null, out: FlatClaim[]): Promise<void> {
		const own = await this.blocked(c);
		out.push({ claim: own, parent });
		const credited = own.kind === 'release' || own.kind === 'recording' ? await this.creditRules(own.artists ?? []) : own.kind === 'label' ? (own.artists ?? []) : [];
		for (const a of credited) await this.flatten(a, own, out);
		if (own.kind !== 'release') return;
		for (const r of own.recordings ?? []) await this.flatten({ ...r, artists: r.artists?.length ? r.artists : own.artists }, own, out);
		const label = labelOf(own);
		if (label) await this.flatten(label, own, out);
	}

	// The object the claim's representation already sits on.
	holder(c: CatalogClaim): Promise<string | null> {
		return this.batch([alone(c)], () => this.b!.representation(c));
	}

	// The object the claim's identifiers already name, and whether its length
	// allows it to be the same recording (identity.ts recordingByIsrcOk).
	named(c: CatalogClaim, durationSec?: number): Promise<{ id: string; fits: boolean } | null> {
		return this.batch([alone(c)], async () => {
			const hit = await this.b!.byIdentifier(c);
			return hit && { id: hit.id, fits: hit.namespace !== 'isrc' || (await this.b!.isrcOk(hit.id, durationSec)) };
		});
	}

	// Attaches a claim to an object already decided (the planner confirmed it
	// by evidence ingestion cannot see): representation, identifiers, facts.
	attachTo(objectId: string, c: CatalogClaim): Promise<void> {
		return this.batch(
			[alone(c)],
			async () => {
				const rep = await this.b!.represent(c, objectId);
				this.attachIdentifiers(c, objectId, rep.id);
				await this.attachFacts(c, objectId);
				await this.linkTextLabel(c, objectId, rep.id);
				if (rep.inserted) this.creditsGap(c, objectId);
			},
			[objectId],
		);
	}

	// A release gains a page on a store that credits every track in full, and
	// the page came without its tracklist (a listing, a link someone found, a
	// device's match): if Deezer alone credited the release's tracks, the page
	// is read for their credits (credits.ts). A claim carrying its tracklist
	// brings the credits itself.
	private creditsGap(c: CatalogClaim, objectId: string): void {
		if (c.kind !== 'release' || c.recordings?.length || !isCreditStore(c.provider)) return;
		this.credits.add(objectId);
	}

	// A claim's identifiers onto an object the claim's representation already
	// sits on (the ISRC fill, planner.ts): nothing else of the claim is read.
	attachIdentifiersOnly(objectId: string, c: CatalogClaim): Promise<void> {
		return this.batch([alone(c)], async () => {
			const rep = await this.b!.heldRepresentation(c);
			if (rep) this.attachIdentifiers(c, objectId, rep);
		});
	}

	// Attaches a claim to the object it names only if the catalogue already has
	// one (by representation, identifier or the identity rules); nothing is
	// created and no relationship written — except the claim's genres when
	// asked (a device's facts-up: a store's genre is a fact about the
	// recording, not a tie to another object). Null when it names nothing known.
	// `about`: the object the sender holds the claim to be about, checked by
	// the caller against the claim (catalog.ts agrees) and taken only when the
	// catalogue's own rules name nothing.
	attachIfKnown(c: CatalogClaim, opts: { genres?: boolean; about?: string | null } = {}): Promise<IngestOutcome | null> {
		return this.batch(
			[c],
			async () => {
				const objectId = (await this.b!.representation(c)) ?? (await this.candidate(c)) ?? opts.about ?? null;
				if (!objectId) return null;
				const rep = await this.b!.represent(c, objectId);
				if (rep.inserted) this.stats.attached++;
				this.attachIdentifiers(c, objectId, rep.id);
				await this.attachFacts(c, objectId);
				await this.linkTextLabel(c, objectId, rep.id);
				if (opts.genres && c.genres?.length) await this.attachGenres(c.provider, c.genres, objectId, rep.id);
				if (rep.inserted) this.creditsGap(c, objectId);
				return { objectId, kind: c.kind, created: false };
			},
			opts.about ? [opts.about] : [],
		);
	}

	// A release's label arriving as text on a claim that is attached, not
	// resolved (a store page found for a release the catalogue holds): tied to
	// the label of that name like any other text.
	private async linkTextLabel(c: CatalogClaim, objectId: string, sourceObjectId: string): Promise<void> {
		const label = c.kind === 'release' && !c.label ? textLabel(c.facts?.labelText) : null;
		if (!label) return;
		const l = await this.nested(label);
		if (l.kind === 'label') this.edge(objectId, 'release-label', l.objectId, sourceObjectId, null, null);
	}

	// Releases whose label the catalogue holds as text only, tied to the label
	// of that name: the back catalogue's pass (label-texts.ts) and a label a
	// device found for a release's track (catalog.ts attachFacts).
	// `sourceObjectId`: the representation that said so, the link's evidence.
	// Returns how many named a label (a distributor's name names none).
	async labelsByText(rows: readonly { releaseId: string; text: string; sourceObjectId: string }[]): Promise<number> {
		const named = rows.flatMap((r) => {
			const label = textLabel(r.text);
			return label ? [{ ...r, label }] : [];
		});
		if (!named.length) return 0;
		await this.batch(
			named.map((r) => r.label),
			async () => {
				for (const r of named) {
					const label = await this.nested(r.label);
					if (label.kind === 'label') this.edge(r.releaseId, 'release-label', label.objectId, r.sourceObjectId, null, null);
				}
			},
			named.map((r) => r.releaseId),
		);
		return named.length;
	}

	// Each claim resolved afresh from here on, as by a new ingester: the next
	// poll of a batch may say more of a claim than an earlier one did (a
	// listing's bare release, then the release in full).
	forget(): void {
		this.memo.clear();
		this.heldMemo.clear();
	}

	// Several claims, in as few batches as they fit in. In order, not in
	// parallel: claims in one batch often share artists and releases.
	async claims(claims: readonly CatalogClaim[]): Promise<IngestOutcome[]> {
		const out: IngestOutcome[] = [];
		for (let i = 0; i < claims.length; ) {
			let j = i;
			for (let n = 0; j < claims.length && (j === i || n + nodes(claims[j]!) <= BATCH_NODES); j++) n += nodes(claims[j]!);
			const chunk = claims.slice(i, j);
			await this.batch(chunk, async () => {
				for (const c of chunk) out.push(await this.claim(c));
			});
			i = j;
		}
		return out;
	}

	claim(c: CatalogClaim): Promise<IngestOutcome> {
		return this.batch([c], () => this.nested(c));
	}

	private nested(c: CatalogClaim, parent?: ClaimParent): Promise<IngestOutcome> {
		const key = `${c.provider}|${c.kind}|${c.providerId}`;
		let p = this.memo.get(key);
		if (!p) {
			p = this.blocked(c).then((weak) => this.resolve(weak, parent));
			this.memo.set(key, p);
		}
		return p;
	}

	// The credit rules and blocked store ids (loadIngestRules), read once per
	// ingest — or once for many, when the caller hands them in.
	private rulesMemo: IngestRules | null = null;
	private rules(): IngestRules {
		this.rulesMemo ??= this.ctx.rules ?? loadIngestRules(this.tx);
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

	// The tracks a release held before this ingest, read once per release; a
	// held track one incoming track took is struck, so a tracklist cannot
	// land twice on one recording.
	private readonly heldMemo = new Map<string, HeldTrack[]>();
	private async held(releaseId: string): Promise<HeldTrack[]> {
		let h = this.heldMemo.get(releaseId);
		if (!h) {
			h = await this.b!.held(releaseId);
			this.heldMemo.set(releaseId, h);
		}
		return h;
	}

	private async resolve(c: CatalogClaim, parent?: ClaimParent): Promise<IngestOutcome> {
		const b = this.b!;
		let objectId = await b.representation(c);
		let created = false;
		if (!objectId) objectId = await this.candidate(c, parent);
		if (!objectId) {
			objectId = this.create(c).id;
			created = true;
			this.stats.created++;
		}
		const repNew = await b.represent(c, objectId);
		if (!created && repNew.inserted) {
			this.stats.attached++;
			// A watched object reachable on one more provider gains that
			// provider's tracker.
			if (isLiveKind(c.kind)) this.cursors.add(objectId);
		}
		this.attachIdentifiers(c, objectId, repNew.id);
		await this.attachFacts(c, objectId);
		await this.attachRelationships(c, objectId, repNew.id, parent);
		if (!created && repNew.inserted) this.creditsGap(c, objectId);
		if (created) this.recordGaps(c, objectId);
		return { objectId, kind: c.kind, created };
	}

	// An existing object this claim is about, by the rules of identity.ts.
	private async candidate(c: CatalogClaim, parent?: ClaimParent): Promise<string | null> {
		const b = this.b!;
		const byId = await b.byIdentifier(c);
		if (byId) {
			if (byId.namespace !== 'isrc' || (await b.isrcOk(byId.id, c.facts?.durationSec))) return byId.id;
		}
		const fold = nameFold(c.name);
		switch (c.kind) {
			case 'recording': {
				// Inside a release the catalogue holds, the slot rule first
				// (slots.ts): the same title in the same slot or within three
				// seconds is the same track whatever each store's credits say.
				if (parent?.kind === 'release') {
					const hit = slotMatch(await this.held(parent.id), { title: c.name, position: parent.position, durationSec: c.facts?.durationSec }, parent.artistFolds ?? []);
					if (hit) {
						this.heldMemo.set(parent.id, (await this.held(parent.id)).filter((h) => h.id !== hit.id));
						return hit.id;
					}
				}
				return b.recordingByKey(recordingKey(c.name, (c.artists ?? []).map((a) => a.name)), c.facts?.durationSec);
			}
			case 'release':
				// By credited names, before any artist is resolved: the artists
				// then corroborate through the release found (attachRelationships).
				return b.releaseByTitle(
					fold,
					(c.artists ?? []).map((a) => a.name).filter((n) => !!nameFold(n)),
					releaseAtOf(c.facts?.releaseDate),
				);
			case 'artist':
				return parent ? b.corroborated(c.kind, fold, parent, c.provider) : null;
			case 'label':
				// On the release it arrives with, else by its name alone: a
				// label is the label of that name (IngestBatch.labelNamed).
				return (parent ? await b.corroborated(c.kind, fold, parent, c.provider) : null) ?? b.labelNamed(fold, c);
			default:
				return null;
		}
	}

	private create(c: CatalogClaim): Obj {
		const o = this.b!.create(c, c.kind === 'recording' ? recordingKey(c.name, (c.artists ?? []).map((a) => a.name)) : null);
		// A new label may be one the catalogue holds under another name: checked
		// now and while its releases arrive (label-related.ts).
		if (c.kind === 'label') this.b!.task(o.id, 'dedupe', 'catalog');
		return o;
	}

	// Identifiers of the wrong kind, malformed, or already naming another
	// object are dropped: an ISRC on two recordings is a provider's error the
	// catalogue does not copy.
	private attachIdentifiers(c: CatalogClaim, objectId: string, sourceObjectId: string): void {
		for (const ident of c.identifiers ?? []) {
			if (NAMESPACE_KIND[ident.namespace] !== c.kind) continue;
			const value = normalizeIdentifier(ident.namespace, ident.value);
			if (value) this.b!.identify(ident.namespace, value, objectId, sourceObjectId);
		}
	}

	private async attachFacts(c: CatalogClaim, objectId: string): Promise<void> {
		const live = isLiveKind(c.kind);
		const facts: FactRow[] = Object.entries(c.facts ?? {})
			.filter(([, v]) => v !== undefined && v !== null)
			.map(([field, value]) => ({ field, source: c.provider, value }));
		for (const f of facts) this.b!.fact(objectId, f.field, f.source, f.value, live);
		const o = await this.b!.object(objectId);
		const next = foldAttrs(o.attrs, facts, { live, liveSource: c.provider });
		// A name key is someone's spelling of the name (a store's text, a
		// file's tag, an upload's title), not a store's word on what the object
		// is called: it names a new object and never renames one.
		const rename = live && c.name !== o.name && !((isNameKey(c) || isCreditLine(c)) && !o.fresh);
		if (JSON.stringify(next) === JSON.stringify(o.attrs) && !rename) return;
		this.b!.fold(o, next, c, rename);
	}

	private async attachRelationships(c: CatalogClaim, objectId: string, sourceObjectId: string, parent?: ClaimParent): Promise<void> {
		// A track's credits know the release they arrive in: the release's own
		// credits are written before its tracklist, so they corroborate the
		// track's (a store's track-level copy of the release artist).
		const self: ClaimParent = { id: objectId, kind: c.kind, release: c.kind === 'recording' && parent?.kind === 'release' ? parent.id : undefined };
		if (c.kind === 'release') {
			for (const [i, a] of (await this.creditRules(c.artists ?? [])).entries()) {
				const artist = await this.nested(a, self);
				if (artist.kind === 'artist') this.edge(artist.objectId, 'artist-release', objectId, sourceObjectId, i === 0 ? 'main' : 'credited', i);
			}
			const artistFolds = (c.artists ?? []).map((a) => nameFold(a.name)).filter(Boolean);
			for (const [i, r] of (c.recordings ?? []).entries()) {
				// A tracklist entry without its own credits carries the release's.
				const position = r.facts?.trackNumber ?? i + 1;
				const rec = await this.nested({ ...r, artists: r.artists?.length ? r.artists : c.artists }, { ...self, position, artistFolds });
				if (rec.kind === 'recording') this.edge(objectId, 'release-recording', rec.objectId, sourceObjectId, null, position);
			}
			// Deezer's tracklist names a track's primary artist only: where no
			// other store credited these tracks, the release's Spotify or
			// Beatport page is read for the rest (credits.ts).
			if (c.provider === 'deezer' && c.recordings?.length) this.credits.add(objectId);
			const stated = labelOf(c);
			if (stated) {
				const label = await this.nested(stated, self);
				if (label.kind === 'label') this.edge(objectId, 'release-label', label.objectId, sourceObjectId, null, null);
			}
		}
		if (c.kind === 'recording') {
			for (const [i, a] of (await this.creditRules(c.artists ?? [])).entries()) {
				const artist = await this.nested(a, self);
				if (artist.kind === 'artist') this.edge(objectId, 'recording-artist', artist.objectId, sourceObjectId, i === 0 ? 'main' : 'credited', i);
			}
		}
		// A label's roster, as the provider lists it (Bandcamp's artists page).
		if (c.kind === 'label') {
			for (const [i, a] of (c.artists ?? []).entries()) {
				const artist = await this.nested(a, self);
				if (artist.kind === 'artist') this.edge(objectId, 'label-artist', artist.objectId, sourceObjectId, null, i);
			}
		}
		if (c.genres?.length) await this.attachGenres(c.provider, c.genres, objectId, sourceObjectId);
	}

	// Onto the canonical taxonomy where an alias says so; an unknown string is
	// recorded as unmapped (an operator maps it or leaves it orthogonal) and
	// kept as the source's 'genres' fact.
	private async attachGenres(provider: CatalogProvider, genres: string[], objectId: string, sourceObjectId: string): Promise<void> {
		this.b!.fact(objectId, 'genres', provider, genres, false);
		for (const raw of genres) {
			const fold = nameFold(raw);
			if (!fold) continue;
			const genre = await this.b!.alias(provider, fold);
			if (genre) this.edge(objectId, 'object-genre', genre, sourceObjectId, null, null);
		}
	}

	private edge(src: string, kind: string, dst: string, sourceObjectId: string, role: string | null, position: number | null): void {
		this.b!.edge(src, kind, dst, sourceObjectId, role, position);
	}

	// What a new static object is missing that another provider can supply.
	private recordGaps(c: CatalogClaim, objectId: string): void {
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
		for (const [need, provider] of gaps) this.b!.task(objectId, need, provider);
	}
}

// A claim without the ones it names: only the claim itself is read for.
export const alone = (c: CatalogClaim): CatalogClaim => ({ ...c, artists: undefined, recordings: undefined, label: undefined });

export const nodes = (c: CatalogClaim): number => 1 + (c.artists?.length ?? 0) + (c.label ? 1 : 0) + (c.recordings ?? []).reduce((n, r) => n + nodes(r), 0);

// A canonical edge with one source's evidence beside it; the edge is made
// once, the evidence once per source.
export async function addEdge(tx: Queryable, src: string, kind: string, dst: string, sourceObjectId: string, role: string | null = null, position: number | null = null): Promise<void> {
	const [row] = await tx.query<{ id: string }>(
		`with ins as (
			insert into curator.catalog_edge (src, kind, dst, role, position) values ($1, $2, $3, $4, $5::int)
			on conflict (src, kind, dst) do nothing returning id
		)
		select id from ins union all select id from curator.catalog_edge where src = $1 and kind = $2 and dst = $3 limit 1`,
		[src, kind, dst, role, position === null ? null : String(position)],
	);
	await tx.query(`insert into curator.catalog_edge_evidence (edge_id, source_object_id) values ($1, $2) on conflict do nothing`, [row!.id, sourceObjectId]);
}

// Releases a source lists as a label's (its catalogue playlist), tied to the
// label, each by its own representation's evidence: `release-label`.
export async function linkReleasesToLabel(tx: Queryable, labelId: string, releases: { objectId: string; claim: Pick<CatalogClaim, 'provider' | 'kind' | 'providerId'> }[]): Promise<number> {
	if (!releases.length) return 0;
	const rows = await tx.query(
		`with x as (
			select distinct on (w.o) w.o, s.id as so from jsonb_to_recordset($2::text::jsonb) as w(o uuid, p text, k text, i text)
			join curator.catalog_source_object s on s.provider = w.p and s.kind = w.k and s.provider_id = w.i order by w.o, s.id
		), ins as (
			insert into curator.catalog_edge (src, kind, dst) select x.o, 'release-label', $1::uuid from x order by x.o
			on conflict (src, kind, dst) do nothing returning id, src
		), e as (
			select id, src from ins union all
			select e.id, e.src from x join curator.catalog_edge e on e.src = x.o and e.kind = 'release-label' and e.dst = $1::uuid
		), ev as (
			insert into curator.catalog_edge_evidence (edge_id, source_object_id) select e.id, x.so from e join x on x.o = e.src on conflict do nothing
		)
		select 1 as linked from x`,
		[labelId, JSON.stringify(releases.map((r) => ({ o: r.objectId, p: r.claim.provider, k: r.claim.kind, i: r.claim.providerId })))],
	);
	return rows.length;
}

export async function ingestClaims(tx: Queryable, claims: CatalogClaim[], ctx: IngestContext): Promise<{ outcomes: IngestOutcome[]; created: number; attached: number }> {
	const ingester = new Ingester(tx, ctx);
	const outcomes = await ingester.claims(claims);
	return { outcomes, ...ingester.stats };
}
