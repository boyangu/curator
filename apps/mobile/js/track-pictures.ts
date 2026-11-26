// The player's artist and label pictures, from the Global Catalog. The phone
// holds no artist ids at any store (artist_link stays on the desktop), so the
// way in is the recording: its best Spotify claim resolves to the catalogue's
// recording, whose credits name the artist objects, each with its picture.
// The label resolves by its folded name, as the desktop's catalog-refs.ts
// asks. A few calls once per track; the Kotlin side keeps what comes back.

import type Database from 'better-sqlite3';
import type {
	CatalogBrowseInput,
	CatalogBrowseResult,
	CatalogGetInput,
	CatalogObjectDetail,
	CatalogRef,
	CatalogResolveInput,
	CatalogResolveResult,
} from '@curator/protocol';
import { nameFold } from '@curator/library-logic';

export type Picture = { name: string; imageUrl: string | null };
export type TrackPictures = { artists: Picture[]; label: Picture | null };

export type PictureCatalog = {
	resolve(input: CatalogResolveInput): Promise<CatalogResolveResult>;
	browse(input: CatalogBrowseInput): Promise<CatalogBrowseResult>;
	get(input: CatalogGetInput): Promise<CatalogObjectDetail>;
};

// More credits than a player shows are not worth a call each.
const MAX_ARTISTS = 6;

export async function trackPictures(raw: Database.Database, catalog: PictureCatalog, o: { deviceId: string; brief: boolean }, trackId: string): Promise<TrackPictures> {
	const t = raw
		.prepare(
			`select coalesce(json_extract(t.overrides, '$.label'), t.label) as label,
				(select c.source_track_id from claim_link c where c.track_id = t.id and c.source = 'spotify' order by c.rank limit 1) as spotify
			from track t where t.id = ?`,
		)
		.get(trackId) as { label: string | null; spotify: string | null } | undefined;
	if (!t) return { artists: [], label: null };
	const label = t.label?.trim() || null;
	const fold = label ? nameFold(label) : '';

	const refs: CatalogRef[] = [];
	if (t.spotify) refs.push({ provider: 'spotify', kind: 'recording', providerId: t.spotify });
	if (fold) refs.push({ provider: 'user', kind: 'label', providerId: `name:${fold}` });
	if (refs.length === 0) return { artists: [], label: label ? { name: label, imageUrl: null } : null };
	const { objects } = await catalog.resolve({ deviceId: o.deviceId, refs });
	const recording = t.spotify ? (objects[0] ?? null) : null;
	const labelObject = fold ? (objects[refs.length - 1] ?? null) : null;

	let artists: Picture[] = [];
	if (recording) {
		const b = await catalog.browse({ deviceId: o.deviceId, id: recording.id, ...(o.brief ? { brief: true } : {}) });
		const credits = (b.artists ?? []).slice(0, MAX_ARTISTS);
		// One without its picture still names the artist: the player draws initials.
		const details = await Promise.all(credits.map((a) => catalog.get({ deviceId: o.deviceId, id: a.id }).catch(() => null)));
		artists = credits.map((a, i) => ({ name: a.name, imageUrl: details[i]?.coverUrl ?? null }));
	}
	return { artists, label: label ? { name: label, imageUrl: labelObject?.coverUrl ?? null } : null };
}
