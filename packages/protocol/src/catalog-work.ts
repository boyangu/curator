// Device work ('catalog_device_work'): the cloud plans, the device reads.
//
// Every catalogue read a device makes may carry its PROFILE — the stores it
// can read right now — and the answer may then carry WORK: the store reads
// the catalogue wants for what was just fetched. The device does the jobs it
// can, shows what it finds at once, and reports (catalog-work-report.ts); the
// cloud checks every find itself before it saves anything, and may answer a
// report with follow-up work. A device never decides what needs reading, and
// never which store page is an artist's or a label's: the work names the
// page. Staleness, sizes, the daily store counts and the off switch are the
// cloud's settings (apps/cloud catalog/work), so they change without a
// release of any device.
//
// Three jobs, one per thing a device can do for the catalogue:
//   find     read the listing of a store page the cloud names (an artist's
//            or a label's) and say what it lists: the releases it lacks.
//   release  complete or check one release: read the pages it has without a
//            tracklist, find it at the stores it is not on, and re-read a
//            page long unconfirmed to say whether it is still that release.
//   facts    BPM, key, genre and label for tracks that lack them.
//
// No job is leased: two devices that open one artist both get the work, and
// the cloud merges what both report.
//
// This file holds what rides on reads (the profile in, the work out) and has
// no runtime import of catalog-service.ts, which extends its inputs with the
// profile; what a device sends back is in catalog-work-report.ts.

import { z } from 'zod';
import type { CatalogHandle, CatalogProvider } from './catalog-service.js';

// The stores a device may be asked to read. Tidal and Apple answer only a
// caller holding Curator's own key, so the cloud asks them itself; SoundCloud
// and YouTube likewise.
export const CATALOG_WORK_STORES = ['spotify', 'deezer', 'beatport', 'bandcamp', 'traxsource'] as const satisfies readonly CatalogProvider[];
export type CatalogWorkStore = (typeof CATALOG_WORK_STORES)[number];
export const CATALOG_FACTS_STORES = ['beatport', 'traxsource'] as const satisfies readonly CatalogWorkStore[];
export type CatalogFactsStore = (typeof CATALOG_FACTS_STORES)[number];

export const CATALOG_DEVICE_FORMS = ['phone', 'desktop'] as const;
export type CatalogDeviceForm = (typeof CATALOG_DEVICE_FORMS)[number];

// What a device says of itself with a read. `stores`: readable now (its
// Spotify login vends, Beatport gets through, the user has not switched the
// store off); empty when the user switched device reading off — the answer
// then carries no work. `resting`: stores it would read but for a rate limit
// or a block of its own, until when (epoch ms). `reader`: the version of its
// reading code, so the cloud can stop asking a build that reads wrongly.
// `visit`: one page visit's running count — the cloud caps the rounds and the
// releases a visit is handed, and a device says how far it is.
export type CatalogDeviceProfile = {
	form: CatalogDeviceForm;
	reader: number;
	stores: CatalogWorkStore[];
	resting?: { store: CatalogWorkStore; until: number }[];
	visit?: { id: string; round: number; taken: number };
};

const ZWorkStore = z.enum(CATALOG_WORK_STORES);
export const ZCatalogDeviceProfile = z
	.object({
		form: z.enum(CATALOG_DEVICE_FORMS),
		reader: z.number().int().positive().max(1_000_000),
		stores: z.array(ZWorkStore).max(CATALOG_WORK_STORES.length),
		resting: z.array(z.object({ store: ZWorkStore, until: z.number().int().nonnegative() }).strict()).max(CATALOG_WORK_STORES.length).optional(),
		visit: z.object({ id: z.string().min(8).max(64), round: z.number().int().nonnegative().max(100), taken: z.number().int().nonnegative().max(100_000) }).strict().optional(),
	})
	.strict();

// A store page as a reader's target takes it.
export type CatalogWorkPage = { provider: CatalogWorkStore; providerId: string; url: string | null };

// Job ids say what the job is, so a report needs no memory on the cloud's
// side of what was handed out (nothing is leased):
//   find:<object id | new>:<provider>:<provider id>
//   find:<object id>:search:<provider>
//   release:<release id>
//   facts:<release id>
// The cloud re-derives what a report's id may touch; an id is a name, never
// an authority.
export type CatalogFindJob = {
	id: string;
	kind: 'find';
	// Null: an artist or a label the catalogue does not hold yet, read by the
	// page the device itself named (its hint).
	objectId: string | null;
	of: 'artist' | 'label';
	name: string;
	// The page to read, with the cursor its last reading left ({} at first).
	// `probe`: a page the catalogue holds but has never read — its listing is
	// compared with the object's own before anything of it is kept.
	page?: CatalogWorkPage & { cursor: Record<string, unknown>; probe?: boolean };
	// A label the catalogue knows only by name: search the store for it.
	search?: { store: CatalogWorkStore };
};

export type CatalogWorkTrack = { id: string; title: string; artists: string[]; durationSec: number | null; isrc: string | null; position: number | null };

export type CatalogReleaseJob = {
	id: string;
	kind: 'release';
	objectId: string;
	// The release as the catalogue holds it: what a find is compared against.
	release: { title: string; artists: string[]; date: string | null; upcs: string[]; tracks: CatalogWorkTrack[] };
	// Pages it holds to read in full, in this order: it has no tracklist yet,
	// or none of its tracks is on that store (the page is its own already —
	// it is read, never searched for again).
	read: CatalogHandle[];
	// Stores it is not on: find it there (ISRC, then UPC, then title and
	// artist — each confirmed by the tracklist).
	find: CatalogWorkStore[];
	// Pages last confirmed long ago: read them and say if this is still it.
	check: CatalogHandle[];
};

export type CatalogFactsJob = {
	id: string;
	kind: 'facts';
	// Asked in this order; a later store only fills what an earlier left.
	stores: CatalogFactsStore[];
	tracks: (CatalogWorkTrack & { label: string | null })[];
};

export type CatalogJob = CatalogFindJob | CatalogReleaseJob | CatalogFactsJob;

// What an answer carries beside its data. `limits`: the rounds of follow-up
// work one visit may run and the releases it may be handed in all — the
// cloud's settings for this form of device, told so the device can show how
// far it is.
export type CatalogWork = { jobs: CatalogJob[]; limits: { rounds: number; releases: number } };

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _profile: Same<z.infer<typeof ZCatalogDeviceProfile>, CatalogDeviceProfile> = true;
void _profile;
