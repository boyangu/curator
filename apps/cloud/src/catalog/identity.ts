// Which catalogue object a claim is about, conservatively. A wrong merge is
// expensive (two artists' releases interleaved for every watcher) and a missed
// one is cheap (a duplicate the identity sweep or an operator joins later), so
// every rule here leans towards "new object":
//
//   - an exact representation (provider, kind, id) always wins;
//   - a recording by ISRC, unless the lengths disagree by more than 10 s;
//     else by recordingKey (title + artist set, version kept) and length
//     within 5 s, and only when exactly one object fits;
//   - a release by UPC; else by folded title, a shared credited artist and a
//     release date within two days, again only when exactly one fits;
//   - an artist or a label NEVER by name alone: only a representation, a
//     global identifier, or a namesake already tied to the very release or
//     recording the claim arrives with (the corroboration rule of the
//     desktop KB, apps/core/src/knowledge/identity.ts); for an artist the
//     release counts as a whole (credited on it, on a sibling track, or on a
//     release holding the track), by the twins rule of artist-twins.ts;
//   - playlists, genres and charts by representation only.
//
// catalog_not_same holds the pairs an operator ruled apart; the matchers here
// only ever propose an existing object for a claim with no object yet, so the
// table is consulted where two objects are compared (merges, src/catalog/admin).

import type { CatalogClaim, CatalogIdNamespace, CatalogKind } from '@curator/protocol';
import { normalizeIsrc } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { num } from '../db/db.js';

// The namespace a kind may carry; anything else on a claim is dropped.
export const NAMESPACE_KIND: Record<CatalogIdNamespace, CatalogKind> = {
	isrc: 'recording',
	upc: 'release',
	mbid_artist: 'artist',
	mbid_label: 'label',
	mbid_release: 'release',
	mbid_recording: 'recording',
	discogs_artist: 'artist',
	discogs_label: 'label',
};

// Canonical form of an identifier: ISRCs upper-case without separators, UPCs
// and EANs as digits without leading zeros (a 12-digit UPC and its 13-digit
// EAN are one release), MusicBrainz ids lower-case.
export function normalizeIdentifier(namespace: CatalogIdNamespace, value: string): string | null {
	switch (namespace) {
		case 'isrc':
			return normalizeIsrc(value);
		case 'upc': {
			const digits = value.replace(/\D/g, '').replace(/^0+/, '');
			return digits.length >= 6 && digits.length <= 14 ? digits : null;
		}
		case 'mbid_artist':
		case 'mbid_label':
		case 'mbid_release':
		case 'mbid_recording':
			return /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : null;
		default:
			return /^\d{1,12}$/.test(value) ? value : null;
	}
}

// An artist representation that is only a reader's name key — the library's
// `name:<fold>`, Bandcamp's and the agent import's `<label id>/<fold>` — not
// a store's own id: it says nothing about who the store thinks the artist is.
// SQL over an alias `s` of catalog_source_object.
export const WEAK_SQL = `((s.provider = 'user' and s.provider_id like 'name:%') or s.provider_id like '%/%')`;

const MAX_MERGE_HOPS = 8;

// The live end of a merge chain (an object merged away answers for its winner).
export async function follow(tx: Queryable, id: string): Promise<string> {
	const rows = await tx.query<{ id: string }>(
		`with recursive chain (id, merged_into, depth) as (
			select id, merged_into, 0 from curator.catalog_object where id = $1
			union all
			select o.id, o.merged_into, c.depth + 1 from curator.catalog_object o join chain c on o.id = c.merged_into where c.depth < ${MAX_MERGE_HOPS}
		)
		select id from chain where merged_into is null limit 1`,
		[id],
	);
	return rows[0]?.id ?? id;
}

export async function findRepresentation(tx: Queryable, claim: Pick<CatalogClaim, 'provider' | 'kind' | 'providerId'>): Promise<string | null> {
	const [row] = await tx.query<{ object_id: string }>(
		`select object_id from curator.catalog_source_object where provider = $1 and kind = $2 and provider_id = $3`,
		[claim.provider, claim.kind, claim.providerId],
	);
	return row ? follow(tx, row.object_id) : null;
}

// The object a global identifier on the claim already names.
export async function findByIdentifier(tx: Queryable, claim: CatalogClaim): Promise<{ id: string; namespace: CatalogIdNamespace } | null> {
	for (const ident of claim.identifiers ?? []) {
		if (NAMESPACE_KIND[ident.namespace] !== claim.kind) continue;
		const value = normalizeIdentifier(ident.namespace, ident.value);
		if (!value) continue;
		const [row] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_identifier where namespace = $1 and value = $2`, [ident.namespace, value]);
		if (row) return { id: await follow(tx, row.object_id), namespace: ident.namespace };
	}
	return null;
}

// A recording's ISRC match is refused when the lengths are known and far
// apart: an ISRC reused across a radio edit and an extended mix happens.
export async function recordingByIsrcOk(tx: Queryable, objectId: string, durationSec: number | undefined): Promise<boolean> {
	if (durationSec === undefined) return true;
	const [row] = await tx.query<{ duration_sec: unknown }>(`select duration_sec from curator.catalog_object where id = $1`, [objectId]);
	if (!row || row.duration_sec === null) return true;
	return Math.abs(num(row.duration_sec) - durationSec) <= 10;
}

export async function recordingByKey(tx: Queryable, recKey: string, durationSec: number | undefined): Promise<string | null> {
	const rows = await tx.query<{ id: string }>(
		`select id from curator.catalog_object
		where kind = 'recording' and merged_into is null and rec_key = $1
			and ($2::float8 is null or duration_sec is null or abs(duration_sec - $2::float8) <= 5)
		limit 2`,
		[recKey, durationSec === undefined ? null : String(durationSec)],
	);
	return rows.length === 1 ? rows[0]!.id : null;
}

// A release by title, a credited artist's NAME and a date within two days,
// all three required. Names, not resolved artist objects: the claim's artists
// are only matched through the release they arrive with, so the release has to
// be found first; the three together are strong evidence where one alone
// (a namesake) is not.
export async function releaseByTitle(tx: Queryable, nameFold: string, artistFolds: string[], releaseAtMs: number | null): Promise<string | null> {
	if (!artistFolds.length || releaseAtMs === null) return null;
	const rows = await tx.query<{ id: string }>(
		`select distinct r.id from curator.catalog_object r
		join curator.catalog_edge e on e.dst = r.id and e.kind = 'artist-release'
		join curator.catalog_object a on a.id = e.src
		where r.kind = 'release' and r.merged_into is null and r.name_fold = $1
			and a.name_fold = any($2::text[])
			and r.release_at is not null
			and abs(extract(epoch from r.release_at) - $3::float8 / 1000) <= 2 * 86400
		limit 2`,
		[nameFold, `{${artistFolds.map((f) => `"${f.replace(/["\\]/g, (m) => `\\${m}`)}"`).join(',')}}`, String(releaseAtMs)],
	);
	return rows.length === 1 ? rows[0]!.id : null;
}

// The release or recording a claim arrives with; a recording's claim within
// a release also names that release, which is not yet linked to it while
// its credits resolve.
export type ClaimParent = { id: string; kind: CatalogKind; release?: string };

// A namesake already credited on the release or recording the claim arrives
// with: the only way an artist or label is matched without an id.
//
// Artists follow the twins rule (artist-twins.ts, Guy's rule of 2026-11-01).
// One already on the very track is the same person whatever store holds it.
// One elsewhere on the release — credited on it, on a sibling track, or on a
// release that holds the track — is the same person unless the claiming store
// already holds it under another id of its own (a reader's name key is none):
// a store's two ids are its word that these are two people, left for the
// operator. Of several that fit, the one on the
// track first, then the one more stores hold, then the older: with two copies
// not yet joined on a release, a third store's claim used to mint a third.
export async function corroborated(tx: Queryable, kind: 'artist' | 'label', nameFold: string, parent: ClaimParent, provider?: string): Promise<string | null> {
	let sql: string;
	if (kind === 'artist' && (parent.kind === 'release' || parent.kind === 'recording')) {
		const rows = await tx.query<{ id: string }>(
			`with rel as (
				select $2::uuid as id where $3::text = 'release'
				union select $4::uuid where $4::uuid is not null
				union select e.src from curator.catalog_edge e where $3::text = 'recording' and e.kind = 'release-recording' and e.dst = $2::uuid
			), cand as (
				select e.dst as id, 0 as away from curator.catalog_edge e where $3::text = 'recording' and e.kind = 'recording-artist' and e.src = $2::uuid
				union all
				select e.src, 1 from curator.catalog_edge e join rel on rel.id = e.dst where e.kind = 'artist-release'
				union all
				select ra.dst, 1 from curator.catalog_edge rr join rel on rel.id = rr.src
					join curator.catalog_edge ra on ra.src = rr.dst and ra.kind = 'recording-artist'
					where rr.kind = 'release-recording'
			)
			select o.id from curator.catalog_object o
			join (select id, min(away) as away from cand group by id) c on c.id = o.id
			where o.kind = 'artist' and o.merged_into is null and o.name_fold = $1
				and (c.away = 0 or $5::text is null or not exists (
					select 1 from curator.catalog_source_object s where s.object_id = o.id and s.kind = 'artist' and s.provider = $5::text and not ${WEAK_SQL}))
			order by c.away, (select count(*) from curator.catalog_source_object s where s.object_id = o.id) desc, o.discovered_at, o.id
			limit 1`,
			[nameFold, parent.id, parent.kind, parent.release ?? null, provider ?? null],
		);
		return rows[0]?.id ?? null;
	} else if (kind === 'label' && parent.kind === 'release') {
		sql = `select o.id from curator.catalog_object o join curator.catalog_edge e on e.dst = o.id and e.kind = 'release-label' and e.src = $2
			where o.kind = 'label' and o.merged_into is null and o.name_fold = $1 limit 2`;
	} else if (kind === 'artist' && parent.kind === 'label') {
		// A roster name: the namesake already credited on one of the label's
		// own releases.
		sql = `select distinct o.id from curator.catalog_object o
			join curator.catalog_edge ar on ar.src = o.id and ar.kind = 'artist-release'
			join curator.catalog_edge rl on rl.src = ar.dst and rl.kind = 'release-label' and rl.dst = $2
			where o.kind = 'artist' and o.merged_into is null and o.name_fold = $1 limit 2`;
	} else {
		return null;
	}
	const rows = await tx.query<{ id: string }>(sql, [nameFold, parent.id]);
	return rows.length === 1 ? rows[0]!.id : null;
}
