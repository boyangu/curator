// The page work (work.ts): what the desktop reads and sends up for the entity
// page in front. No database: the catalogue, the pages, the store readers and
// the lookups are all stand-ins.

import { describe, expect, it, vi } from 'vitest';
import type { CatalogClaim, CatalogPageRelease, CatalogPageTrack, CatalogTracker, CatalogTracksResult } from '@curator/protocol';
import type { TrackerPoll, TrackerTarget } from '@curator/catalog-readers';
import type { EntityHeader, EntityRef, EntityWorkEvent } from '@curator/shared';
import type { Enricher } from '../enrich/contract.js';
import type { SpotifyMatchClient } from '../feed/spotify-match.js';
import type { StreamingCatalog } from './streaming.js';
import { createEntityWork, type EntityReaders, type EntityWorkDeps } from './work.js';

const ALL: CatalogTracker[] = ['artist/spotify', 'artist/deezer', 'label/deezer', 'label/beatport', 'label/bandcamp'];

function header(ref: EntityRef, over: Partial<EntityHeader> & { reason?: EntityHeader['world']['reason'] } = {}): EntityHeader {
	const reason = over.reason ?? 'ok';
	return {
		ref,
		imageUrl: null,
		coverTrackId: null,
		facts: {},
		genres: [],
		labels: [],
		artists: [],
		similar: [],
		collabs: [],
		activity: null,
		badges: [],
		reach: null,
		links: [],
		follow: null,
		owned: { count: 0, filter: null },
		world: { available: reason === 'ok', reason, releaseCount: null, trackCount: null },
		...over,
	};
}

const release = (provider: CatalogClaim['provider'], id: string, name: string, extra: Partial<CatalogClaim> = {}): CatalogClaim => ({ provider, kind: 'release', providerId: id, name, ...extra });
const recording = (provider: CatalogClaim['provider'], id: string, name: string): CatalogClaim => ({ provider, kind: 'recording', providerId: id, name });
const poll = (children: CatalogClaim[], pending = false): TrackerPoll => ({ children, listingHash: pending ? 'pending:1' : 'h', cursor: { seen: children.map((c) => c.providerId) }, calls: 1 });

const pageTrack = (id: string, title: string, over: Partial<CatalogPageTrack> = {}): CatalogPageTrack => ({ id, title, position: 1, disc: null, durationSec: 300, isrc: null, bpm: null, key: null, genres: [], artists: [{ id: 'a1', name: 'Northfold' }], handles: [], ...over });
const pageRelease = (id: string, title: string, tracks: CatalogPageTrack[], over: Partial<CatalogPageRelease> = {}): CatalogPageRelease => ({
	id, title, date: '2026-01-02', type: 'single', coverUrl: null, labelText: null, labels: [], artists: [{ id: 'a1', name: 'Northfold' }], genres: [], handles: [], trackCount: tracks.length, appearance: false, tracks, ...over,
});
const page = (releases: CatalogPageRelease[]): CatalogTracksResult => ({ object: { id: 'cat-1', kind: 'artist', name: 'Northfold' }, redirectedFrom: null, releases, nextCursor: null });

function harness(over: {
	header: EntityHeader | (() => EntityHeader);
	readers?: Partial<EntityReaders>;
	known?: (c: { provider: string; providerId: string }) => boolean;
	// Whether a registered claim made a new object (default: it did).
	made?: (c: CatalogClaim) => boolean;
	trackers?: CatalogTracker[];
	enrichers?: Enricher[];
	spotify?: SpotifyMatchClient | null;
	loaded?: CatalogTracksResult[];
	streaming?: StreamingCatalog;
}) {
	const registered: CatalogClaim[][] = [];
	const reported: CatalogClaim[][] = [];
	const labels: string[][] = [];
	const dropped: (string | null)[] = [];
	const listings: { provider: string; target: TrackerTarget }[] = [];
	const events: EntityWorkEvent[] = [];
	const readers: EntityReaders = {
		listing: async () => poll([]),
		deezerRelease: async () => null,
		beatportRelease: async () => null,
		spotifyAlbums: async () => new Map(),
		...over.readers,
	};
	const deps: EntityWorkDeps = {
		catalog: () => ({
			status: () => ({ available: true, reason: 'ok' }),
			resolve: async (refs) => refs.map((r) => (over.known?.(r) ? ({ id: `known-${r.providerId}` } as never) : null)),
			register: async (claims) => { registered.push(claims); return { created: claims.length, attached: 0, made: claims.map((c) => over.made?.(c) ?? true) }; },
			reportEnrichment: async (claims) => { reported.push(claims); return { results: [], created: 0, attached: claims.length, duplicate: false }; },
			enrichLabels: async (names) => { labels.push(names); return { labels: names.length, registered: names.length, queued: names.length }; },
		}),
		pages: {
			page: async () => (typeof over.header === 'function' ? over.header() : over.header),
			loaded: async () => over.loaded ?? [],
			drop: (id) => { dropped.push(id); },
		},
		trackers: () => over.trackers ?? ALL,
		spotify: async () => over.spotify ?? null,
		spotifyToken: async () => (over.spotify ? 'token' : null),
		primary: async () => 'spotify',
		enrichers: over.enrichers ?? [],
		...(over.streaming ? { streaming: () => over.streaming! } : {}),
		readers: { ...readers, listing: async (provider, target, signal) => { listings.push({ provider, target }); return readers.listing(provider, target, signal); } },
		pacingMs: 0,
	};
	const work = createEntityWork(deps);
	work.subscribe((e) => events.push(e));
	// At rest: the last event says no phase, after at least one that said one.
	const rest = () => vi.waitFor(() => {
		expect(events.some((e) => e.status.phase !== null)).toBe(true);
		expect(events[events.length - 1]!.status.phase).toBeNull();
	});
	return { work, events, registered, reported, labels, dropped, listings, rest };
}

const artistRef: EntityRef = { kind: 'artist', name: 'Northfold', catalogId: 'cat-1', spotifyId: 'sp-artist' };

describe('entity page work: listings', () => {
	it('discovers an artist the catalogue does not know from the store the library knows it by', async () => {
		const unknown: EntityRef = { kind: 'artist', name: 'Northfold', libraryId: 'lib-1', spotifyId: 'sp-artist' };
		let known = false;
		const h = harness({
			header: () => (known ? header({ ...unknown, catalogId: 'cat-1' }) : header(unknown, { reason: 'unknown' })),
			spotify: {} as SpotifyMatchClient,
			// Registered: the catalogue knows the artist from here on.
			made: () => (known = true),
			readers: { listing: async (provider) => (provider === 'spotify' ? poll([release('spotify', 'al1', 'Glass Rivers'), release('spotify', 'al2', 'Elsewhere')]) : poll([])) },
		});
		h.work.watch(unknown, 7);
		await h.rest();
		// The artist itself first, then what Spotify listed.
		expect(h.registered).toHaveLength(1);
		expect(h.registered[0]!.map((c) => `${c.kind}:${c.providerId}`)).toEqual(['artist:sp-artist', 'release:al1', 'release:al2']);
		expect(h.events.find((e) => e.status.phase === 'discover' && e.status.source === 'spotify')).toBeTruthy();
		const done = h.events.find((e) => e.changed === 'header')!;
		expect(done.watch).toBe(7);
		expect(done.status.added).toBe(2);
		expect(h.dropped).toEqual([null]);
	});

	it('registers an artist its page is showing from the streaming service with that same read: every release, the newest in full', async () => {
		const unknown: EntityRef = { kind: 'artist', name: 'Northfold', spotifyId: 'sp-artist' };
		const listed = Array.from({ length: 130 }, (_, i) => release('spotify', `al${i}`, `Release ${i}`));
		const asked: string[][] = [];
		let known = false;
		const h = harness({
			// On screen from the service: available, and not the catalogue's.
			header: () => (known ? header({ ...unknown, catalogId: 'cat-1' }) : header(unknown, { world: { available: true, reason: 'ok', releaseCount: 130, trackCount: null, via: 'spotify' } })),
			spotify: {} as SpotifyMatchClient,
			made: () => (known = true),
			streaming: {
				service: 'spotify',
				artist: async () => null,
				listing: async () => ({ total: 130, releases: listed }),
				releases: async (ids) => {
					asked.push([...ids]);
					return new Map(ids.map((id) => [id, release('spotify', id, `Full ${id}`, { recordings: [recording('spotify', `${id}-t`, 'A')] })]));
				},
				search: async () => [],
			},
		});
		// The ref a streaming row hands back names the artist by the stand-in id.
		h.work.watch({ kind: 'artist', name: 'Northfold', catalogId: 'spotify_sp-artist' }, 3);
		await h.rest();
		// The tracker's listing reader was not asked: the page's read is the discovery.
		expect(h.listings).toEqual([]);
		// Twenty a call, the newest hundred.
		expect(asked.map((ids) => ids.length)).toEqual([20, 20, 20, 20, 20]);
		const sent = h.registered.flat();
		expect(sent[0]).toMatchObject({ kind: 'artist', providerId: 'sp-artist' });
		expect(sent).toHaveLength(131);
		expect(sent.filter((c) => c.recordings?.length).length).toBe(100);
		expect(sent[101]).toMatchObject({ providerId: 'al100', name: 'Release 100' });
		expect(h.events.find((e) => e.changed === 'header')!.watch).toBe(3);
	});

	it('looks for updates on a known artist and registers only what the catalogue lacks, once per session', async () => {
		const h = harness({
			header: header(artistRef, { links: [{ source: 'spotify', sourceId: 'sp-artist', url: null }] }),
			spotify: {} as SpotifyMatchClient,
			known: (r) => r.providerId === 'al1',
			// Spotify's copy of a release the catalogue holds from another store:
			// attached there, not a new release.
			made: (c) => c.providerId !== 'al2',
			readers: { listing: async () => poll([release('spotify', 'al1', 'One'), release('spotify', 'al2', 'Two'), release('spotify', 'al3', 'Three')]) },
		});
		h.work.watch(artistRef, 1);
		await h.rest();
		expect(h.listings.map((l) => l.provider)).toEqual(['spotify']);
		expect(h.listings[0]!.target.representation?.providerId).toBe('sp-artist');
		expect(h.registered).toEqual([[release('spotify', 'al2', 'Two'), release('spotify', 'al3', 'Three')]]);
		const done = h.events.find((e) => e.changed === 'tracks')!;
		expect(done.status).toMatchObject({ found: 3, added: 1 });
		expect(h.dropped).toEqual(['cat-1']);
		// Left and opened again: the stores are not read a second time.
		h.work.watch(null, 0);
		h.work.watch(artistRef, 2);
		await new Promise((r) => setTimeout(r, 20));
		expect(h.listings).toHaveLength(1);
	});

	it('keeps polling a listing while the reader holds releases back, each poll from the last one\'s cursor', async () => {
		let round = 0;
		const h = harness({
			header: header(artistRef, { links: [{ source: 'spotify', sourceId: 'sp-artist', url: null }] }),
			spotify: {} as SpotifyMatchClient,
			readers: { listing: async () => (round++ === 0 ? poll([release('spotify', 'al1', 'Glass Rivers')], true) : poll([release('spotify', 'al2', 'Elsewhere')])) },
		});
		h.work.watch(artistRef, 1);
		await h.rest();
		expect(h.listings.map((l) => l.provider)).toEqual(['spotify', 'spotify']);
		expect(h.listings[1]!.target.cursor).toEqual({ seen: ['al1'] });
		expect(h.registered[0]!.map((c) => c.providerId)).toEqual(['al1', 'al2']);
	});

	it("never reads an artist's Deezer page: it is every namesake's, not one artist's", async () => {
		// The catalogue holds a Deezer page for the artist and nothing else to read by.
		const deezerOnly: EntityRef = { kind: 'artist', name: 'Northfold', catalogId: 'cat-1' };
		const h = harness({
			header: header(deezerOnly, { links: [{ source: 'deezer', sourceId: '465319', url: 'https://www.deezer.com/artist/465319' }] }),
			spotify: {} as SpotifyMatchClient,
			readers: { listing: async () => poll([release('deezer', 'd1', "A namesake's")]) },
		});
		h.work.watch(deezerOnly, 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(h.listings).toEqual([]);
		expect(h.registered).toEqual([]);
	});

	it('does not read a source the user unchecked', async () => {
		const h = harness({
			header: header(artistRef, { links: [{ source: 'spotify', sourceId: 'sp-artist', url: null }] }),
			spotify: {} as SpotifyMatchClient,
			trackers: ['label/beatport'],
			readers: { listing: async () => poll([release('spotify', 'al1', 'One')]) },
		});
		h.work.watch(artistRef, 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(h.listings).toEqual([]);
	});

	it('registers an unknown label by name and leaves finding its pages to the catalogue', async () => {
		const ref: EntityRef = { kind: 'label', name: 'Northfold Records' };
		let known = false;
		const h = harness({
			header: () => (known ? header({ ...ref, catalogId: 'lab-1' }) : header(ref, { reason: 'unknown' })),
			readers: { listing: async () => poll([release('deezer', 'd1', 'One')]) },
		});
		h.work.subscribe((e) => { if (e.changed === 'header') known = true; });
		h.work.watch(ref, 1);
		await h.rest();
		expect(h.labels).toEqual([['Northfold Records']]);
		// No store is searched by the label's name.
		expect(h.listings).toEqual([]);
		expect(h.registered).toEqual([]);
		expect(h.events.some((e) => e.changed === 'header')).toBe(true);
	});

	it('reads nothing for a page the catalogue cannot be asked about', async () => {
		const h = harness({ header: header(artistRef, { reason: 'server_off', links: [{ source: 'spotify', sourceId: 'sp-artist', url: null }] }), spotify: {} as SpotifyMatchClient });
		h.work.watch(artistRef, 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(h.listings).toEqual([]);
		expect(h.events.every((e) => e.status.phase === null)).toBe(true);
	});
});

describe('entity page work: a loaded page', () => {
	const quiet = header(artistRef);

	it('reads the tracklists of releases listed without one and has the page read again', async () => {
		const empty = pageRelease('r1', 'Glass Rivers', [], { trackCount: 0, handles: [{ provider: 'beatport', id: 'b1', url: null }] });
		const bare = pageRelease('r2', 'No Store', [], { trackCount: 0 });
		const h = harness({
			header: quiet,
			readers: { beatportRelease: async (id) => (id === 'b1' ? release('beatport', 'b1', 'Glass Rivers', { recordings: [recording('beatport', 't1', 'Glass Rivers')] }) : null) },
		});
		h.work.watch(artistRef, 1);
		h.work.pageLoaded('cat-1', page([empty, bare]));
		await h.rest();
		expect(h.registered).toHaveLength(1);
		expect(h.registered[0]![0]!.recordings).toHaveLength(1);
		expect(h.events.find((e) => e.status.phase === 'tracklists')?.status.total).toBe(2);
		expect(h.events.some((e) => e.changed === 'tracks')).toBe(true);
		expect(h.dropped).toEqual(['cat-1']);
	});

	it('reads a tracklist at Beatport, then Spotify, and at Deezer only when neither has it — without Deezer\'s credits', async () => {
		const asked: string[] = [];
		const artist = (provider: CatalogClaim['provider'], id: string): CatalogClaim => ({ provider, kind: 'artist', providerId: id, name: 'Northfold' });
		const h = harness({
			header: quiet,
			spotify: {} as SpotifyMatchClient,
			readers: {
				beatportRelease: async (id) => { asked.push(`beatport:${id}`); return id === 'b1' ? release('beatport', 'b1', 'On Beatport', { recordings: [recording('beatport', 'bt1', 'On Beatport')] }) : null; },
				spotifyAlbums: async (ids) => { asked.push(`spotify:${ids.join('+')}`); return new Map(ids.filter((id) => id === 's2').map((id) => [id, release('spotify', id, 'On Spotify', { recordings: [recording('spotify', 'st2', 'On Spotify')] })])); },
				deezerRelease: async (id) => {
					asked.push(`deezer:${id}`);
					return release('deezer', id, 'Only On Deezer', { identifiers: [{ namespace: 'upc', value: '0123456789012' }], artists: [artist('deezer', '465319')], recordings: [{ ...recording('deezer', 'dt3', 'Only On Deezer'), artists: [artist('deezer', '465319')] }] });
				},
			},
		});
		const every = (ids: Partial<Record<'beatport' | 'spotify' | 'deezer', string>>) => Object.entries(ids).map(([provider, id]) => ({ provider: provider as 'deezer', id: id!, url: null }));
		h.work.watch(artistRef, 1);
		h.work.pageLoaded('cat-1', page([
			pageRelease('r1', 'On Beatport', [], { trackCount: 0, handles: every({ beatport: 'b1', spotify: 's1', deezer: 'd1' }) }),
			pageRelease('r2', 'On Spotify', [], { trackCount: 0, handles: every({ spotify: 's2', deezer: 'd2' }) }),
			pageRelease('r3', 'Only On Deezer', [], { trackCount: 0, handles: every({ spotify: 's3', deezer: 'd3' }) }),
		]));
		await h.rest();
		// Each store is asked only for what the ones before it did not read.
		expect(asked).toEqual(['beatport:b1', 'spotify:s2+s3', 'deezer:d3']);
		const sent = h.registered[0]!;
		expect(sent.map((c) => `${c.provider}:${c.providerId}`)).toEqual(['beatport:b1', 'spotify:s2', 'deezer:d3']);
		// Deezer's copy: the release's facts and tracklist, nobody's name on it.
		expect(sent[2]).toMatchObject({ identifiers: [{ namespace: 'upc', value: '0123456789012' }] });
		expect(sent[2]!.artists).toBeUndefined();
		expect(sent[2]!.recordings).toEqual([recording('deezer', 'dt3', 'Only On Deezer')]);
	});

	it('fills in what the rows lack, patches them in place and sends the findings up', async () => {
		const lookups: string[] = [];
		const enricher: Enricher = {
			id: 'beatport',
			produces: 'metadata',
			applicableTo: () => true,
			enrich: async (target) => {
				lookups.push(target.query.title);
				return { kind: 'metadata', patch: { bpm: 124, keyCamelot: '8A', genre: 'Melodic House & Techno', label: 'Northfold Records' }, sourceLink: { source: 'beatport', sourceTrackId: 'bp1', url: 'https://www.beatport.com/track/x/1', key: 'A min', bpm: 124 } };
			},
		};
		const whole = pageTrack('rec-2', 'Already Whole', { bpm: 120, key: 'A min', genres: ['House'], handles: [{ provider: 'spotify', id: 'sp-2', url: null }] });
		const bare = pageTrack('rec-1', 'Glass Rivers', { isrc: 'GBAAA2600001' });
		const spotify = {
			getAlbumTracks: async () => [{ id: 'sp-1', name: 'Glass Rivers', duration_ms: 300_000 }, { id: 'sp-2', name: 'Already Whole', duration_ms: 300_000 }],
			searchTracks: async () => [],
			searchAlbums: async () => [],
		} as unknown as SpotifyMatchClient;
		const h = harness({ header: quiet, enrichers: [enricher], spotify });
		h.work.watch(artistRef, 3);
		h.work.pageLoaded('cat-1', page([pageRelease('r1', 'Glass Rivers', [bare, whole], { handles: [{ provider: 'spotify', id: 'al1', url: null }] })]));
		await h.rest();
		// Only the row that lacked its facts was looked up.
		expect(lookups).toEqual(['Glass Rivers']);
		expect(h.work.patchOf('rec-1')).toEqual({ recordingId: 'rec-1', streamIds: { spotify: 'sp-1' }, bpm: 124, keyCamelot: '8A', genre: 'Melodic House & Techno', label: 'Northfold Records' });
		expect(h.work.patchOf('rec-2')).toBeUndefined();
		const rows = h.events.flatMap((e) => e.rows ?? []);
		expect(rows.map((r) => r.recordingId)).toEqual(['rec-1', 'rec-1']);
		expect(h.events.find((e) => e.status.phase === 'details')?.status.total).toBe(2);
		const sent = h.reported.flat();
		expect(sent.map((c) => `${c.provider}:${c.kind}:${c.providerId}`)).toEqual(['spotify:recording:sp-1', 'beatport:recording:bp1']);
		expect(sent[1]).toMatchObject({ identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { bpm: 124, key: 'A min' }, genres: ['Melodic House & Techno'] });
		// A genre went up: the catalogue counts the artist's genres off its
		// recordings', so the header kept from before is dropped and read again.
		expect(h.dropped).toEqual([null]);
		expect(h.events.filter((e) => e.changed === 'header').map((e) => e.watch)).toEqual([3]);
		expect(h.events.some((e) => e.changed === 'tracks')).toBe(false);
		// Read again (the page reloaded): nothing is looked up twice.
		h.work.pageLoaded('cat-1', page([pageRelease('r1', 'Glass Rivers', [bare, whole])]));
		await new Promise((r) => setTimeout(r, 20));
		expect(lookups).toHaveLength(1);
	});

	it('picks up the pages read before the page came to the front, and ignores another entity\'s', async () => {
		const lookups: string[] = [];
		const enricher: Enricher = { id: 'beatport', produces: 'metadata', applicableTo: () => true, enrich: async (t) => { lookups.push(t.query.title); return null; } };
		const h = harness({ header: quiet, enrichers: [enricher], loaded: [page([pageRelease('r1', 'Held', [pageTrack('rec-1', 'Held')])])] });
		h.work.watch(artistRef, 1);
		h.work.pageLoaded('someone-else', page([pageRelease('r9', 'Other', [pageTrack('rec-9', 'Other')])]));
		await h.rest();
		expect(lookups).toEqual(['Held']);
	});

	it('stops when the page is left, and still sends up what it had found', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const lookups: string[] = [];
		const enricher: Enricher = {
			id: 'beatport',
			produces: 'metadata',
			applicableTo: () => true,
			enrich: async (t) => {
				lookups.push(t.query.title);
				if (lookups.length === 2) await gate;
				return { kind: 'metadata', patch: { bpm: 120 }, sourceLink: { source: 'beatport', sourceTrackId: `bp-${lookups.length}` } };
			},
		};
		const h = harness({ header: quiet, enrichers: [enricher] });
		h.work.watch(artistRef, 1);
		h.work.pageLoaded('cat-1', page([pageRelease('r1', 'Three', [pageTrack('rec-1', 'One'), pageTrack('rec-2', 'Two'), pageTrack('rec-3', 'Three')])]));
		await vi.waitFor(() => expect(lookups).toHaveLength(2));
		const before = h.events.length;
		h.work.watch(null, 0);
		release();
		await vi.waitFor(() => expect(h.reported).toHaveLength(1));
		expect(lookups).toEqual(['One', 'Two']);
		// Nothing more is said for a page no longer in front.
		expect(h.events).toHaveLength(before);
		expect(h.reported[0]!.map((c) => c.providerId)).toEqual(['bp-1', 'bp-2']);
		// Findings the header shows nothing of (a BPM): it is not read again.
		expect(h.dropped).toEqual([]);
	});

	it('looks up rows asked for by hand ahead of the page\'s own order, once', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const lookups: string[] = [];
		const enricher: Enricher = {
			id: 'beatport',
			produces: 'metadata',
			applicableTo: () => true,
			enrich: async (t) => {
				lookups.push(t.query.title);
				if (lookups.length === 1) await gate;
				return { kind: 'metadata', patch: { bpm: 120 }, sourceLink: { source: 'beatport', sourceTrackId: `bp-${t.query.title}` } };
			},
		};
		const rows = [pageTrack('rec-1', 'One'), pageTrack('rec-2', 'Two'), pageTrack('rec-3', 'Three')];
		const h = harness({ header: quiet, enrichers: [enricher], loaded: [page([pageRelease('r1', 'Three', rows)])] });
		h.work.watch(artistRef, 1);
		await vi.waitFor(() => expect(lookups).toHaveLength(1));
		// The page is on its first row; the user asks for the last.
		const asked = h.work.enrich(['rec-3', 'not-on-the-page']);
		release();
		expect(await asked).toEqual({ asked: 1, found: 1 });
		await h.rest();
		// Next after the row in hand, and not a second time when the page reaches it.
		expect(lookups).toEqual(['One', 'Three', 'Two']);
		expect(h.work.patchOf('rec-3')).toEqual({ recordingId: 'rec-3', bpm: 120 });
		expect(h.reported.flat().map((c) => c.providerId).sort()).toEqual(['bp-One', 'bp-Three', 'bp-Two']);
		// Every lookup is counted: the page's three, and the one asked for on top.
		const last = h.events.filter((e) => e.status.phase === 'details').pop()!.status;
		expect([last.done, last.total]).toEqual([4, 4]);
	});

	it('asks the stores again for a row the page already tried, and settles what is left when the page is left', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const lookups: string[] = [];
		const enricher: Enricher = {
			id: 'beatport',
			produces: 'metadata',
			applicableTo: () => true,
			enrich: async (t) => {
				lookups.push(t.query.title);
				if (lookups.length === 3) await gate;
				return null;
			},
		};
		const h = harness({ header: quiet, enrichers: [enricher], loaded: [page([pageRelease('r1', 'Held', [pageTrack('rec-1', 'Held'), pageTrack('rec-2', 'Other')])])] });
		// No page in front: nothing to ask.
		expect(await h.work.enrich(['rec-1'])).toEqual({ asked: 0, found: 0 });
		h.work.watch(artistRef, 1);
		await h.rest();
		expect(lookups).toEqual(['Held', 'Other']);
		// By hand, the same row is asked about once more — and still not found.
		const again = h.work.enrich(['rec-1', 'rec-2']);
		await vi.waitFor(() => expect(lookups).toHaveLength(3));
		// The page is left while the first is at the store: the second is never asked.
		h.work.watch(null, 0);
		release();
		expect(await again).toEqual({ asked: 2, found: 0 });
		expect(lookups).toEqual(['Held', 'Other', 'Held']);
	});
});
