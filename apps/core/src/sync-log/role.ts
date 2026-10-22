// Who states what (the 2026-10-22 sync review). One device, the account's
// master, owns the library's sources — its files, its rekordbox, its provider
// accounts — and states what a recording IS; the others (a laptop, a phone)
// receive that and send curation back. Until this gate every device restated
// its own copy of every source fact: the second desktop queued 42,457 such
// ops in its first minute, 478 of them provider album values that would have
// overridden the master's (album.set-meta is plain LWW, not per device), and
// its meta/attrs cells on 26,923 recordings could never win a read.
//
// So a device that is not the master states source facts only for what it
// brought to the account itself: set-meta / set-attrs for a recording whose
// record it created, unless the master describes that recording too (it holds
// a copy); of a playlist another device created, only the user's choices;
// never a provider album (the master fills every release it links, and a
// secondary's answer from the same provider would only race it). Nothing at
// all before its first pull, when it cannot tell whose anything is.
//
// "Created here", not "the master holds no cell": the master may still be
// uploading its cells when a secondary bootstraps — exactly how the profile's
// first minute restated 23,613 recordings whose master cells had not arrived
// yet. A record names its creator from its first op on (the latest create,
// when two devices made one: then the master's meta, which came long before
// its attrs, says the master describes it).
//
// Untouched: curation (tags, cues and the rekordbox units a secondary's own
// rekordbox reports, ratings, comment/colour, playlist contents and order,
// plays, feed decisions). Every device states it; LWW decides.
//
// No information is lost by the gate: the read rule (protocol state.ts
// resolveTrackMeta / resolveTrackAttrs) takes the master's whole cell when
// it has one, so a secondary's cell for such a recording never showed
// anywhere. That rule stays as the safety net for ops already in the log and
// for builds that predate this.

import type Database from 'better-sqlite3';
import { ATTRS_CELL_PREFIX, MASTER_DEVICE_SETTING, META_CELL_PREFIX, masterDeviceOf, type Cell } from '@curator/protocol';
import { getDeviceId } from './device.js';

type Raw = Database.Database;

// Set when a pull first reached the head of the log (or a snapshot loaded):
// from then on this device's records hold every claim the account had, so
// a streaming import binds to the recordings other desktops hold instead of
// minting its own (claim-bind.ts). Device-local; never an account key.
export const FIRST_PULL_KEY = 'sync.first_pull_at';

export function firstPullDone(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(FIRST_PULL_KEY) !== undefined;
}

// The master as the records hold it (the same cell every device's view and
// the server's read), or null when none was ever stated.
export function masterDevice(raw: Raw): string | null {
	const json = raw.prepare(`SELECT value FROM sync_state WHERE map = 'settings' AND key = ?`).pluck().get(MASTER_DEVICE_SETTING) as string | undefined;
	if (!json) return null;
	try {
		return masterDeviceOf(new Map([[MASTER_DEVICE_SETTING, JSON.parse(json) as Cell]]));
	} catch {
		return null;
	}
}

// 'all': this device is the master, or the account names none yet and this
// device has seen the account (the first device of a new library states
// itself master on that same cycle, client.ts ensureMaster).
// 'own': a secondary; it speaks only for what it created (see the top).
// 'none': not yet — no source statement until the first pull.
export type SourceRole = { speaks: 'all' } | { speaks: 'own'; self: string; master: string } | { speaks: 'none' };

export function sourceRole(raw: Raw): SourceRole {
	const master = masterDevice(raw);
	const self = getDeviceId(raw);
	if (master !== null && master === self) return { speaks: 'all' };
	if (!firstPullDone(raw)) return { speaks: 'none' };
	return master === null ? { speaks: 'all' } : { speaks: 'own', self, master };
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

// The recordings among `recs` a secondary leaves alone: another device
// created the record (one with no create — a catalogue row the log never
// carried, or a record this device's own set-meta just started — names no
// creator, and only the master's cells decide), or the master describes it — a non-null cell of its
// under either prefix, since the master states set-meta and set-attrs for
// the same rows and the meta came first (v3; the profile's records held the
// master's meta on all 34,870 of its recordings while their attrs were still
// on the way). One read per chunk; json_type is NULL for a missing cell and
// 'null' for one nulled out. A recording with no record at all is not
// returned: nothing describes it but this device.
export function leftToOthers(raw: Raw, role: { self: string; master: string }, recs: readonly string[]): Set<string> {
	if (recs.length === 0) return new Set();
	const cell = (prefix: string): string => `$.fields."${prefix}${role.master}".value`;
	return new Set(raw.prepare(`SELECT key FROM sync_state WHERE map = 'libraryTracks' AND key IN (${marks(recs.length)})
		AND (coalesce(json_extract(value, '$.created.device'), ?) != ?
			OR coalesce(json_type(value, ?), 'null') != 'null' OR coalesce(json_type(value, ?), 'null') != 'null')`)
		.pluck().all(...recs, role.self, role.self, cell(META_CELL_PREFIX), cell(ATTRS_CELL_PREFIX)) as string[]);
}

// Whether a secondary states only the user's choices of a playlist or
// folder: another device created it (no create: as leftToOthers), or the master has stated any of
// `fields` (a field's clock names the device that won it).
export function playlistLeftToOthers(raw: Raw, map: 'playlists' | 'playlistFolders', id: string, role: { self: string; master: string }, fields: readonly string[]): boolean {
	const json = raw.prepare(`SELECT value FROM sync_state WHERE map = ? AND key = ?`).pluck().get(map, id) as string | undefined;
	if (!json) return false;
	try {
		const rec = JSON.parse(json) as { created?: { device?: string } | null; fields?: Record<string, { clock?: { device?: string } }> };
		if ((rec.created?.device ?? role.self) !== role.self) return true;
		return fields.some((f) => rec.fields?.[f]?.clock?.device === role.master);
	} catch {
		return false;
	}
}
