// A master change re-runs this device's source backfills (role.ts): a device
// just promoted states what it left to the old master — the drains'
// baselines keep that to rows it never stated — and a demoted one finds
// nothing it may say. The same keys a new build bumps to re-queue every row.

import type Database from 'better-sqlite3';
import { ALBUM_META_BACKFILL_KEY } from './album-meta.js';
import { PLAYLIST_ATTRS_BACKFILL_KEY } from './playlist-attrs.js';
import { TRACK_ANALYSIS_BACKFILL_KEY } from './track-analysis.js';
import { TRACK_ATTRS_BACKFILL_KEY } from './track-attrs.js';
import { TRACK_META_BACKFILL_KEY } from './track-meta.js';

export function requestRestatement(raw: Database.Database): void {
	raw.prepare(`DELETE FROM app_setting WHERE key IN (?, ?, ?, ?, ?)`)
		.run(TRACK_META_BACKFILL_KEY, TRACK_ATTRS_BACKFILL_KEY, PLAYLIST_ATTRS_BACKFILL_KEY, ALBUM_META_BACKFILL_KEY, TRACK_ANALYSIS_BACKFILL_KEY);
}
