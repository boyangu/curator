// A track's waveform peaks from the account's analysis catalogue, for a
// device that never analysed it (a phone; a desktop's on-demand fetch,
// apps/core catalogue/layer.ts fetchPeaksOnce, applies its policy around the
// same steps): the recording's claimed audio hash, the catalogue's newest
// peaks item for it (the hi tier, else lo), the blob downloaded and checked
// against the item (size, sha256, .cpk header and version).
//
// Since protocol v5 the analysis itself rides the op log (track_analysis);
// the catalogue moves only peaks, one track at a time when a player asks.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CatalogueLookupResult, CatalogueLookupInput, PeaksTier } from '@curator/protocol';
import { masterDevice } from '../sync-log/track-meta.js';

type Raw = Database.Database;

// ── .cpk header (apps/core analyzer/cpk.ts holds the format and the codec) ──

export const CPK_MAGIC = Buffer.from('CURPEAKS', 'ascii');
// Current writer version. v3 carries num_channels + peak/rms; the decoder
// still reads v1 (mono peak) and v2 (mono/stereo peak).
export const CPK_VERSION = 3;
export const CPK_NUM_BANDS = 3;
// v1 header is 20 bytes; v2/v3 insert num_channels (1 byte) at offset 10.
export const CPK_HEADER_SIZE_V1 = 20;
export const CPK_HEADER_SIZE_V2 = 21;

// The format version when `buf` is a whole .cpk (header sane, body at least
// as long as the header says), else null. Header only: decoding would split
// an 8 MB hi tier into arrays just to say yes.
export function cpkVersionOf(buf: Uint8Array): number | null {
	if (buf.byteLength < CPK_HEADER_SIZE_V1) return null;
	for (let i = 0; i < CPK_MAGIC.length; i++) if (buf[i] !== CPK_MAGIC[i]) return null;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = dv.getUint8(8);
	if (version < 1 || version > 3 || dv.getUint8(9) !== CPK_NUM_BANDS) return null;
	const channels = version === 1 ? 1 : dv.getUint8(10);
	if (channels !== 1 && channels !== 2) return null;
	const spsOff = version === 1 ? 10 : 11;
	if (buf.byteLength < spsOff + 10) return null;
	const detail = dv.getUint32(spsOff + 2, true);
	const overview = dv.getUint32(spsOff + 6, true);
	const header = version === 1 ? CPK_HEADER_SIZE_V1 : CPK_HEADER_SIZE_V2;
	const metrics = version === 3 ? 2 : 1;
	return buf.byteLength >= header + (detail + overview) * CPK_NUM_BANDS * metrics * channels ? version : null;
}

// ── file-less rows (2026-10-21 audit item 3) ────────────────────────────────
// A device without the file — a fresh second desktop, a streaming-only row,
// a phone — still knows which audio the account analysed for a recording:
// the recording's `audio_hash` claims (every device that holds the file
// states one). Exactly one hash names it. Several (a re-encoded or second
// copy merged into the recording) name it only if the master device
// (track-meta.ts masterDevice) claimed exactly one of them — its file is the
// one the account's metadata comes from; otherwise the recording is
// ambiguous and skipped, the same rule a track with two live files follows.

export type ClaimedHash = { hash: string | null; ambiguous: boolean };

const IN_CHUNK = 500;

export function claimedHashes(raw: Raw, recordingIds: readonly string[], master: string | null): Map<string, ClaimedHash> {
	const out = new Map<string, ClaimedHash>();
	for (let i = 0; i < recordingIds.length; i += IN_CHUNK) {
		const chunk = recordingIds.slice(i, i + IN_CHUNK);
		// `+map`: through the recording index (the claims map is ~100k rows).
		const rows = raw.prepare(`SELECT recording_id AS rec, substr(parent_id, 12) AS hash, json_extract(value, '$.cell.clock.device') AS dev
			FROM sync_state WHERE recording_id IN (${chunk.map(() => '?').join(',')}) AND +map = 'claims'
				AND parent_id >= 'audio_hash:' AND parent_id < 'audio_hash;'`).all(...chunk) as Array<{ rec: string; hash: string; dev: string | null }>;
		const by = new Map<string, Array<{ hash: string; dev: string | null }>>();
		for (const r of rows) { let l = by.get(r.rec); if (!l) by.set(r.rec, (l = [])); l.push(r); }
		for (const [rec, list] of by) {
			const all = new Set(list.map((c) => c.hash));
			if (all.size === 1) { out.set(rec, { hash: [...all][0]!, ambiguous: false }); continue; }
			const mine = new Set(list.filter((c) => master !== null && c.dev === master).map((c) => c.hash));
			out.set(rec, mine.size === 1 ? { hash: [...mine][0]!, ambiguous: false } : { hash: null, ambiguous: true });
		}
	}
	return out;
}

// ── the fetch ────────────────────────────────────────────────────────────────

export type FetchedPeaks = { tier: PeaksTier; bytes: Uint8Array };

/**
 * The track's peaks as the account holds them (the hi tier, else lo), checked,
 * or null: no claimed hash (never analysed anywhere, or ambiguous), nothing in
 * the catalogue for it. Throws when the transport or the blob does (offline,
 * a blob that does not match its item): the caller may ask again later.
 */
export async function fetchPeaks(deps: {
	raw: Raw;
	deviceId: string;
	lookup(input: CatalogueLookupInput): Promise<CatalogueLookupResult>;
	download(path: string): Promise<Uint8Array>;
}, trackId: string): Promise<FetchedPeaks | null> {
	const rec = deps.raw.prepare(`SELECT recording_id FROM track WHERE id = ?`).pluck().get(trackId) as string | undefined;
	if (!rec) return null;
	const hash = claimedHashes(deps.raw, [rec], masterDevice(deps.raw)).get(rec)?.hash;
	if (!hash) return null;
	const { items } = await deps.lookup({ deviceId: deps.deviceId, audioHashes: [hash], want: [{ unit: 'peaks', variant: 'hi' }, { unit: 'peaks', variant: 'lo' }] });
	const peaks = items.filter((i) => i.unit === 'peaks' && i.audioHash === hash);
	// hi when the account has it, else lo: one download, not two.
	const pick = peaks.find((i) => i.variant === 'hi') ?? peaks.find((i) => i.variant === 'lo');
	if (!pick || pick.unit !== 'peaks') return null;
	const blob = pick.data.blob;
	const bytes = await deps.download(blob.path);
	if (bytes.byteLength !== blob.bytes || createHash('sha256').update(bytes).digest('hex') !== blob.sha256) {
		throw new Error(`the peaks blob ${blob.path} does not match its catalogue item`);
	}
	if (cpkVersionOf(bytes) !== pick.data.cpkVersion) throw new Error(`the peaks blob ${blob.path} is not a whole .cpk v${pick.data.cpkVersion}`);
	return { tier: pick.variant as PeaksTier, bytes };
}
