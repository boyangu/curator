// Which differences are failures. The run compares against the REAL
// rekordbox and the master's REAL Curator, which disagree on their own:
// Curator holds edits it never pushed, rekordbox holds edits Curator never
// pulled. A fresh desktop that links and pushes is right to show those, so
// every difference is classed:
//
//   expected  the fresh desktop did what the master's own Curator would do
//             (rekordbox.compare: it pushed exactly the master's value), or
//             took what rekordbox really holds (cloud.afterLink)
//   artefact  the run's own setup: the joiner's row for that file is another
//             recording than the master's (joiner.ts attach bound the file
//             by audio hash elsewhere), or the master never linked that row
//   failure   everything else — a push or pull the master would not make
//
// Only failures fail a check. Value-based where a cheap view exists
// (title, artist, album, label, genre, rating, tags, cues, playlist
// members), else by the master's timestamps: track.updated_at past
// rekordbox_link.pushed_at (Curator ahead), djmdContent.updated_at past
// rb_updated_at_seen (rekordbox ahead).

import type Database from 'better-sqlite3';
import { effectiveAlbum, effectiveArtistName, effectiveGenre, effectiveLabel, effectiveTitle } from '@curator/core/e2e';
import { searchFold, type ArtistCreditFormat, type TrackArtist, type TrackOverrides } from '@curator/shared';
import type { RbDump } from './compare-rb.js';

type Raw = Database.Database;

export type DiffClass = 'expected' | 'artefact' | 'failure';
export type Classified = { class: DiffClass; note: string };

// The master would leave the field alone (omit-if-empty, no rb tags, no
// cues it claims): a difference there is a push the master never makes.
const NO_OPINION = Symbol('no opinion');
// No cheap value view: fall back to the timestamps.
const NO_VIEW = Symbol('no view');
type MasterValue = unknown | typeof NO_OPINION | typeof NO_VIEW;

type MasterLink = {
	trackId: string;
	recordingId: string | null;
	title: string;
	artists: TrackArtist[];
	albumTitle: string | null;
	label: string | null;
	genre: string | null;
	rating: number | null;
	overrides: TrackOverrides | null;
	cuesEditedAt: number | null;
	updatedAt: number;
	pushedAt: number | null;
	rbUpdatedAtSeen: number | null;
};

const json = <T>(v: string | null, fallback: T): T => {
	if (v == null) return fallback;
	try { return JSON.parse(v) as T; } catch { return fallback; }
};

export function creditFormatOf(raw: Raw): ArtistCreditFormat {
	const v = json<Partial<ArtistCreditFormat>>(raw.prepare(`SELECT value FROM app_setting WHERE key = 'credit_format'`).pluck().get() as string | null ?? null, {});
	return { separator: v.separator === '/' || v.separator === ';' ? v.separator : ',', remixStyle: v.remixStyle === 'dash' ? 'dash' : 'parenthesis' };
}

// rekordbox content id → the track the device links it to.
function linksOf(raw: Raw): Map<string, MasterLink> {
	const rows = raw.prepare(`SELECT l.rb_content_id AS cid, t.id, t.recording_id, t.title, t.artists, t.album_title, t.label, t.genre, t.rating, t.overrides,
			t.cues_edited_at, t.updated_at, l.pushed_at, l.rb_updated_at_seen
		FROM rekordbox_link l JOIN track t ON t.id = l.track_id`).all() as Array<Record<string, unknown>>;
	return new Map(rows.map((r) => [String(r['cid']), {
		trackId: String(r['id']),
		recordingId: (r['recording_id'] as string | null) ?? null,
		title: String(r['title'] ?? ''),
		artists: json<TrackArtist[]>(r['artists'] as string | null, []),
		albumTitle: (r['album_title'] as string | null) ?? null,
		label: (r['label'] as string | null) ?? null,
		genre: (r['genre'] as string | null) ?? null,
		rating: (r['rating'] as number | null) ?? null,
		overrides: json<TrackOverrides | null>(r['overrides'] as string | null, null),
		cuesEditedAt: (r['cues_edited_at'] as number | null) ?? null,
		updatedAt: Number(r['updated_at'] ?? 0),
		pushedAt: (r['pushed_at'] as number | null) ?? null,
		rbUpdatedAtSeen: (r['rb_updated_at_seen'] as number | null) ?? null,
	}]));
}

// rekordbox's DjmdCue.Kind for a hot slot (reader.py _HOT_KIND_TO_SLOT,
// inverted: A..H skip Kind 4, I..P follow).
const SLOT_TO_HOT_KIND = new Map<number, number>([[0, 1], [1, 2], [2, 3], [3, 5], [4, 6], [5, 7], [6, 8], [7, 9], ...Array.from({ length: 8 }, (_, i) => [8 + i, 10 + i] as [number, number])]);

// A Curator cue as writer.py apply_cues lands it, in rb_dump's form
// (compare-rb.ts contentView): kind|inMs|outMs|cti|comment.
export function cueForm(c: { slot: number; kind: string; positionSec: number; lengthSec: number | null; color: string | null; name: string | null }): string | null {
	const hot = c.kind === 'hot';
	const kind = hot ? SLOT_TO_HOT_KIND.get(c.slot) : 0;
	if (kind === undefined) return null;
	const inMs = Math.round(c.positionSec * 1000);
	const outMs = c.lengthSec ? Math.round(c.lengthSec * 1000) + inMs : -1;
	const cti = hot && c.color?.startsWith('cti:') ? Number(c.color.slice(4)) || 0 : 0;
	return `${kind}|${inMs}|${outMs}|${cti}|${c.name ?? ''}`;
}

const sameSet = (a: unknown, b: unknown): boolean => {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	const x = new Set(a.map(String));
	const y = new Set(b.map(String));
	return x.size === y.size && [...x].every((v) => y.has(v));
};
const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export type RbDiffItem =
	| { kind: 'content'; contentId: string; field: string; pushed: unknown; reference: unknown }
	| { kind: 'playlist'; playlistId: string; field: string; pushed: unknown; reference: unknown };

// rekordbox.compare: the pushed copy against the untouched one, judged by
// what the master (the founder copy) would have pushed.
export function rekordboxClassifier(founder: Raw, joiner: Raw, reference: RbDump): (d: RbDiffItem) => Classified {
	const fmt = creditFormatOf(founder);
	const master = linksOf(founder);
	const joined = linksOf(joiner);
	const tagStmt = founder.prepare(`SELECT g.name FROM track_tag tt JOIN tag g ON g.id = tt.tag_id WHERE tt.track_id = ? AND tt.tag_id LIKE 'rb\\_%' ESCAPE '\\'`).pluck();
	const cueStmt = founder.prepare(`SELECT slot, kind, position_sec AS positionSec, length_sec AS lengthSec, color, name FROM cue WHERE track_id = ?`);
	const memberStmt = founder.prepare(`SELECT l.rb_content_id FROM playlist_track pt JOIN rekordbox_link l ON l.track_id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.order_key, pt.id`).pluck();

	const masterValue = (m: MasterLink, field: string): MasterValue => {
		const text = (v: string | null): MasterValue => (nonEmpty(v) ? v.trim() : NO_OPINION);
		switch (field) {
			case 'title': return text(effectiveTitle(m, fmt));
			case 'artist': return text(effectiveArtistName(m, fmt));
			case 'album': return text(effectiveAlbum(m));
			case 'label': return text(effectiveLabel(m));
			case 'genre': return text(effectiveGenre(m));
			case 'rating': return m.rating != null && m.rating > 0 ? m.rating : NO_OPINION;
			case 'commentTags':
			case 'myTags': {
				const names = tagStmt.all(m.trackId) as string[];
				return names.length > 0 ? names : NO_OPINION;
			}
			case 'cues': {
				const cues = cueStmt.all(m.trackId) as Array<{ slot: number; kind: string; positionSec: number; lengthSec: number | null; color: string | null; name: string | null }>;
				if (cues.length === 0 && m.cuesEditedAt == null) return NO_OPINION;
				return cues.map(cueForm).filter((c): c is string => c !== null).sort();
			}
			default: return NO_VIEW;
		}
	};

	// Why the two sides differ, from the master's stamps; `stamped` is false
	// when neither side's stamp moved.
	const why = (m: MasterLink, contentId: string): { note: string; stamped: boolean } => {
		if (m.pushedAt == null || m.updatedAt >= m.pushedAt) return { stamped: true, note: 'rekordbox behind Curator: the master changed this after its last push' };
		const rbAt = reference.contents[contentId]?.updatedAtMs ?? null;
		if (rbAt != null && (m.rbUpdatedAtSeen == null || rbAt > m.rbUpdatedAtSeen)) return { stamped: true, note: 'rekordbox edited after the master\'s last pull; the first link kept the account\'s value' };
		return { stamped: false, note: 'the master would push this value but has not (no newer stamp on either side: a composition change, or an edit that left track.updated_at alone)' };
	};
	// The account's own write time for a track's cue set, as the founder's
	// fold stamps it (initial-push.ts: cues_edited_at, else the cue's
	// creation). rekordbox's row edited later than that must win the first
	// link (importer.ts decideFirstLinkSide); the account's set surviving it
	// is the first-link rule failing, not drift.
	const cueStampStmt = founder.prepare(`SELECT max(coalesce(t.cues_edited_at, 0), coalesce(max(c.created_at), 0)) FROM track t LEFT JOIN cue c ON c.track_id = t.id WHERE t.id = ?`).pluck();
	const rbNewerThanCues = (m: MasterLink, contentId: string): boolean => {
		const rbAt = reference.contents[contentId]?.updatedAtMs ?? null;
		const at = cueStampStmt.get(m.trackId) as number | null;
		return rbAt != null && at != null && at > 0 && rbAt > at && (m.rbUpdatedAtSeen == null || rbAt > m.rbUpdatedAtSeen);
	};

	return (d) => {
		if (d.kind === 'playlist') {
			if ((d.field !== 'playlist.members' && d.field !== 'playlist.order') || !Array.isArray(d.pushed)) return { class: 'failure', note: 'no master view for this playlist difference' };
			const linked = new Set(joined.keys());
			const members = (memberStmt.all(`rb_${d.playlistId}`) as string[]).filter((c) => linked.has(c));
			if (d.field === 'playlist.members') {
				return sameSet(d.pushed, members)
					? { class: 'expected', note: 'rekordbox behind Curator: the master\'s playlist holds these members' }
					: { class: 'failure', note: 'pushed members differ from the master\'s playlist' };
			}
			// Order. rekordbox reordered and the master never pulled it: the
			// joiner's pull adopts rekordbox's order (no baseline, so rekordbox's
			// order leads), the push writes it back, and there is no difference
			// to see. So an order difference is expected only as the master's
			// own order (the master reordered and never pushed); anything else
			// (TrackNo renumbering, duplicates, unlinked members interleaved) is
			// the push writing an order neither side holds.
			const pushedOrder = (d.pushed as unknown[]).map(String);
			return JSON.stringify(pushedOrder) === JSON.stringify([...new Set(members)])
				? { class: 'expected', note: 'rekordbox behind Curator: the master\'s playlist order, never pushed' }
				: { class: 'failure', note: 'pushed order matches neither the master\'s playlist nor rekordbox' };
		}
		const m = master.get(d.contentId);
		const j = joined.get(d.contentId);
		if (!m) return { class: 'artefact', note: 'the master never linked this rekordbox row' };
		if (j && j.recordingId !== m.recordingId) return { class: 'artefact', note: `the joiner's row for this file is recording ${j.recordingId}, the master's ${m.recordingId}` };
		const want = masterValue(m, d.field);
		if (want === NO_VIEW) {
			const reason = why(m, d.contentId);
			return reason.stamped ? { class: 'expected', note: `${reason.note} (timestamps only)` } : { class: 'failure', note: 'no value view and no newer stamp on either side' };
		}
		if (want === NO_OPINION) return { class: 'failure', note: 'pushed a value the master would not push (it has none)' };
		const equal = Array.isArray(want) ? sameSet(d.pushed, want) : d.pushed === want;
		if (!equal) return { class: 'failure', note: `the master would push ${JSON.stringify(want)}` };
		if (d.field === 'cues' && rbNewerThanCues(m, d.contentId)) return { class: 'failure', note: 'rekordbox\'s cues are a later edit than the account\'s, yet the first link kept the account\'s set' };
		return { class: 'expected', note: why(m, d.contentId).note };
	};
}

// cloud.afterLink: what linking changed on the joiner, judged by what the
// untouched rekordbox holds for the row the joiner linked, and by the master
// (the founder copy) for what the account held.
export function afterLinkClassifier(founder: Raw, joiner: Raw, reference: RbDump): (table: string, left: Record<string, unknown> | null, right: Record<string, unknown> | null) => Classified {
	const contentOf = new Map<string, string>();
	for (const [cid, l] of linksOf(joiner)) if (l.recordingId) contentOf.set(l.recordingId, cid);
	const master = linksOf(founder);
	const accountCredits = founder.prepare(`SELECT artists FROM track WHERE recording_id = ? AND derived_from_track_id IS NULL ORDER BY deleted_at IS NOT NULL LIMIT 1`).pluck();
	const creditsOf = (v: unknown): TrackArtist[] => (Array.isArray(v) ? v as TrackArtist[] : json<TrackArtist[]>(typeof v === 'string' ? v : null, []));
	const nameKey = (v: string): string => searchFold(v).replace(/[^\p{L}\p{N}]/gu, '');
	// rekordbox's artist line names it (fold, punctuation and spaces aside).
	const rbNames = (artist: string | null | undefined, name: string): boolean => !!artist && nameKey(name) !== '' && nameKey(artist).includes(nameKey(name));
	const livePlaylists = new Map(reference.playlists.filter((p) => !p.deleted).map((p) => [p.id, p]));
	const rbPlaylist = (playlistId: unknown): string | null => (typeof playlistId === 'string' && playlistId.startsWith('rb_') ? playlistId.slice(3) : null);
	const fail = (note: string): Classified => ({ class: 'failure', note });
	return (table, left, right) => {
		const row = right ?? left!;
		const cid = contentOf.get(String(row['recordingId'] ?? ''));
		const rb = cid ? reference.contents[cid] : undefined;
		// The run's own setup: the joiner bound this file to another
		// recording than the master's (joiner.ts attach, by audio hash).
		const m = cid ? master.get(cid) : undefined;
		if (m?.recordingId && row['recordingId'] && m.recordingId !== row['recordingId']) {
			return { class: 'artefact', note: `the joiner's row for this file is recording ${String(row['recordingId'])}, the master's ${m.recordingId}` };
		}
		switch (table) {
			case 'credits': {
				// The account had no credits: rekordbox's artist line is the
				// only value, and the first link takes it (decideFirstLinkSide
				// rule 2).
				const now = creditsOf(right?.['artists']);
				if (creditsOf(left?.['artists']).length === 0 && now.length > 0 && now.every((a) => rbNames(rb?.artist, a.name))) {
					return { class: 'expected', note: 'the account had no credits; rekordbox\'s artist, taken by the first link' };
				}
				return fail('linking rekordbox should never change this table');
			}
			case 'trackArtists': {
				if (!left && right && creditsOf(accountCredits.get(String(right['recordingId'])) ?? null).length === 0 && rbNames(rb?.artist, String(right['artist'] ?? ''))) {
					return { class: 'expected', note: 'the account had no credits; rekordbox\'s artist, taken by the first link' };
				}
				return fail('linking rekordbox should never change this table');
			}
			case 'rbAnalysis': {
				const keyOnly = !!right && (!left || (JSON.stringify(left['grid']) === JSON.stringify(right['grid']) && left['segments'] === right['segments']));
				if (keyOnly && rb && right!['key'] === rb.keyCamelot) return { class: 'expected', note: 'rekordbox holds this key; the master\'s rb slot was empty or stale (its pull re-reads only rows rekordbox changed)' };
				return fail('rb analysis that rekordbox does not hold');
			}
			case 'tracks': {
				if (left && right && left['state'] === right['state'] && left['overrides'] === right['overrides'] && left['deleted'] === right['deleted'] && rb && (right['rating'] ?? 0) === (rb.rating ?? 0)) {
					return { class: 'expected', note: 'rekordbox\'s rating, taken by the first link (later write, or the account had none: rating 0 never pushes)' };
				}
				return fail('a track state rekordbox does not hold');
			}
			case 'cues': {
				if (!cid) return fail('cue on a recording the joiner did not link');
				const forms = new Set((reference.cues[cid] ?? []).map(([kind, inMs, outMs, cti, comment]) => `${kind}|${inMs}|${outMs ?? -1}|${cti ?? 0}|${comment ?? ''}`));
				const form = (r: Record<string, unknown>): string | null => cueForm(r as Parameters<typeof cueForm>[0]);
				if (right && !forms.has(form(right) ?? '')) return fail('a cue rekordbox does not hold');
				if (!right && left && forms.has(form(left) ?? '')) return fail('dropped a cue rekordbox still holds');
				return { class: 'expected', note: right ? 'a rekordbox cue the master never pulled' : 'a cue rekordbox no longer holds' };
			}
			case 'playlists': {
				if (right && !left && right['source'] === 'rekordbox' && livePlaylists.has(String(right['sourceId']))) return { class: 'expected', note: 'a rekordbox playlist the master never pulled' };
				return fail('a playlist change rekordbox does not explain');
			}
			case 'playlistTracks': {
				const pid = rbPlaylist(row['playlistId']);
				const p = pid ? livePlaylists.get(pid) : undefined;
				if (!p) return fail('a membership change outside rekordbox\'s playlists');
				if (!cid) return fail('a member the joiner has not linked to rekordbox (Curator-only) changed in a rekordbox playlist');
				const member = p.members.includes(cid);
				if (right && !left) return member ? { class: 'expected', note: 'a rekordbox membership the master never pulled' } : fail('added a member rekordbox does not hold');
				if (left && !right) return member ? fail('removed a member rekordbox still holds') : { class: 'expected', note: 'a member rekordbox removed' };
				// A move: rekordbox's order explains it only for a member
				// rekordbox's playlist holds (a twin linked in its place moved
				// to the end, e2e 2026-10-24).
				return member ? { class: 'expected', note: 'rekordbox\'s playlist order, adopted by the pull' } : fail('moved a member rekordbox\'s playlist does not hold');
			}
			default:
				return fail('linking rekordbox should never change this table');
		}
	};
}
