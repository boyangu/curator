// The catalogue (workstream D, phase 1): analysis one device computed, shared
// with the same user's other devices so they do not compute it again. The
// server stores and hands back; it never analyses and never judges a result
// beyond its shape.
//
// Every item is keyed by (audio hash, unit, variant, version), never by
// recording id: a beatgrid, a waveform or a segment list depends on the
// decoded samples of one encoding, and the audio hash survives tag rewrites
// (apps/core/src/ingest/audio-hash.ts). It is also global, which is what
// phase 2 (sharing across users) needs; nothing here assumes one user.
//
// Small units ride inline as JSON (`data`); waveform peaks and AI vectors are
// files in Supabase Storage that the device uploads and downloads itself with
// its own session, under `<uid>/…` (sql/storage.sql). An item for those units
// carries a `BlobRef` naming the object, which the server checks exists with
// the stated size before it records the item.

import { z } from 'zod';
import { utf8ByteLength } from './ops.js';
import { ZDeviceId } from './sync-input.js';

// ── units ───────────────────────────────────────────────────────────────────

// One row per unit, in the order the desktop's analyzer produces them.
//   rhythm       bpm, beatgrid, downbeats
//   key          camelot key + strength
//   structure    analyzer segments + the five derived scalars
//   advanced     learned brightness/power, the Essentia scalars, the
//                MusicExtractor blob
//   fingerprint  Chromaprint of the first 120 s + its AcoustID duration
//   peaks        a `.cpk` file per tier (lo, hi)
//   vectors      a packed vector file per model (catalogue-pack.ts)
export const CATALOGUE_UNITS = ['rhythm', 'key', 'structure', 'advanced', 'fingerprint', 'peaks', 'vectors'] as const;
export type CatalogueUnit = (typeof CATALOGUE_UNITS)[number];

export const INLINE_UNITS = ['rhythm', 'key', 'structure', 'advanced', 'fingerprint'] as const;
export type InlineUnit = (typeof INLINE_UNITS)[number];

export const BLOB_UNITS = ['peaks', 'vectors'] as const;
export type BlobUnit = (typeof BLOB_UNITS)[number];

export function isBlobUnit(unit: CatalogueUnit): unit is BlobUnit {
	return unit === 'peaks' || unit === 'vectors';
}

// Inline units have one variant: the analyzer's default method. A result from
// a non-default rhythm method (or rekordbox's grid) is never shared, so there
// is nothing else to name yet.
export const DEFAULT_VARIANT = 'default';
export const PEAKS_TIERS = ['lo', 'hi'] as const;
export type PeaksTier = (typeof PEAKS_TIERS)[number];

// The variant text the server stores: `default`, a peaks tier, or a model id
// such as `mert-v2-fullsong@1`. Lower-case, no slash: it never becomes part of
// a Storage path, but it is a key, so it stays boring.
export const VARIANT_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
export const ZVariant = z.string().regex(VARIANT_RE);
// `<model key>@<adapter version>`, the MIR layer's modelId.
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}@[0-9]{1,6}$/;

// The shape version of each unit's `data`, bumped when the shape changes. A
// reader passes the highest it understands as `maxSchema`; the server refuses
// an item claiming a schema newer than it knows (it could not validate it).
export const CATALOGUE_UNIT_SCHEMA: Readonly<Record<CatalogueUnit, number>> = {
	rhythm: 1,
	key: 1,
	structure: 1,
	advanced: 1,
	fingerprint: 1,
	peaks: 1,
	vectors: 1,
};

// ── keys ────────────────────────────────────────────────────────────────────

// The three schemes the desktop's hasher writes. Kept identical to the CHECK
// on curator.catalogue_item.audio_hash (sql/0004_catalogue.sql); a cloud test
// compares the two texts.
export const AUDIO_HASH_RE = /^(?:pcm-md5:[0-9a-f]{32}|mp3-sha256:[0-9a-f]{64}|mp4-sha256:[0-9a-f]{64})$/;
export const ZAudioHash = z.string().regex(AUDIO_HASH_RE);

// The producer's version as integers, `[2, 4, 0]` for analyzer 2.4.0, `[1]`
// for a vector adapter version. Postgres compares int[] element by element,
// and a shorter array that is a prefix of a longer one sorts first, which
// `compareVersions` mirrors; a writer sends the same length for one unit.
export const ZAnalysisVersion = z.array(z.number().int().min(0).max(65535)).min(1).max(4);

export function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// '2.4.0' → [2, 4, 0]; null for anything that is not dotted integers (the
// desktop's 'rekordbox' marker, which never reaches the catalogue).
export function parseVersionString(v: string): number[] | null {
	const parts = v.split('.');
	if (parts.length < 1 || parts.length > 4 || !parts.every((p) => /^\d{1,5}$/.test(p))) return null;
	const n = parts.map(Number);
	return n.every((x) => x <= 65535) ? n : null;
}

// ── blobs ───────────────────────────────────────────────────────────────────

export const CATALOGUE_BUCKET = 'catalogue';
// The bucket's file_size_limit (sql/storage.sql). A hi `.cpk` of a two-hour
// mix is ~8.6 MB, a vector pack ~150 KB.
export const MAX_CATALOGUE_BLOB_BYTES = 16 * 1024 * 1024;

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ZSha256 = z.string().regex(SHA256_RE);

const BLOB_LAYOUT: Readonly<Record<BlobUnit, { dir: string; ext: string }>> = {
	peaks: { dir: 'peaks', ext: 'cpk' },
	vectors: { dir: 'vec', ext: 'cvec' },
};

// Content-addressed and per user: `<uid>/peaks/<sha256>.cpk`,
// `<uid>/vec/<sha256>.cvec`. Objects are immutable (no update policy), so the
// same bytes always land at the same path and a re-upload is a no-op; the
// Storage policies accept no other layout.
export function catalogueBlobPath(userId: string, unit: BlobUnit, sha256: string): string {
	const l = BLOB_LAYOUT[unit];
	return `${userId.toLowerCase()}/${l.dir}/${sha256}.${l.ext}`;
}

export type BlobRef = {
	// Object name in the `catalogue` bucket, exactly `catalogueBlobPath(...)`.
	path: string;
	sha256: string;
	bytes: number;
};

export const ZBlobRef = z
	.object({
		path: z.string().min(1).max(200),
		sha256: ZSha256,
		bytes: z.number().int().min(1).max(MAX_CATALOGUE_BLOB_BYTES),
	})
	.strict();

// ── unit data ───────────────────────────────────────────────────────────────

const ZNum = z.number().finite();
const ZNumOrNull = ZNum.nullable();
const ZCount = z.number().int().min(0).max(100_000).nullable();

// Standard base64 with padding, of a whole number of float32 values (the
// desktop's Float32 LE grid blobs). 2 MB of text is a 3.5-hour track at
// 300 BPM; the per-item data cap below is the real limit.
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function base64ByteLength(s: string): number {
	const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
	return (s.length / 4) * 3 - pad;
}
const ZFloat32Base64 = z
	.string()
	.max(2_000_000)
	.regex(B64_RE, 'not base64')
	.refine((s) => base64ByteLength(s) % 4 === 0, 'not a whole number of float32 values');
const ZBase64 = z.string().max(64 * 1024).regex(B64_RE, 'not base64');

export type RhythmData = {
	bpm: number;
	// Float32 LE beat times in seconds, base64.
	beatgrid: string;
	downbeats: string;
};

export type KeyData = {
	// '1A'..'12B'.
	camelot: string;
	strength: number | null;
};

// An analyzer segment (`SegmentRecord` with `source` 'analyzer' or absent).
// Rekordbox phrases are never shared, so their fields have no place here.
export type StructureSegment = {
	startSec: number;
	endSec: number;
	label: string;
	source?: 'analyzer';
	confidence?: number;
	energy?: number;
};

export type StructureData = {
	segments: StructureSegment[];
	introLengthSec: number | null;
	outroLengthSec: number | null;
	firstDropSec: number | null;
	dropCount: number | null;
	breakdownCount: number | null;
};

export type AdvancedData = {
	brightness: number | null;
	power: number | null;
	dynamicComplexity: number | null;
	loudnessRangeLu: number | null;
	dissonance: number | null;
	density: number | null;
	// The MusicExtractor blob (`features_json`), verbatim.
	features: Record<string, unknown> | null;
};

export type FingerprintData = {
	// Chromaprint in STANDARD padded base64. `source_link.fingerprint` holds
	// Chromaprint's own URL-safe unpadded form; the desktop converts both ways
	// (catalogue/local.ts chromaprintToStd / chromaprintFromStd) so the wire
	// has one canonical encoding and the digest is stable across devices.
	chromaprint: string;
	// The integer duration AcoustID wants beside it.
	durationSec: number;
};

export type PeaksData = {
	blob: BlobRef;
	// The `.cpk` format version in the file's header (cpk.ts), so a reader
	// that cannot decode it skips the download.
	cpkVersion: number;
};

export type VectorsData = {
	blob: BlobRef;
	// What the pack holds (catalogue-pack.ts), so a reader can size it
	// before the download.
	dim: number;
	count: number;
};

export type UnitDataMap = {
	rhythm: RhythmData;
	key: KeyData;
	structure: StructureData;
	advanced: AdvancedData;
	fingerprint: FingerprintData;
	peaks: PeaksData;
	vectors: VectorsData;
};
export type UnitData = UnitDataMap[CatalogueUnit];

const ZRhythmData = z.object({ bpm: ZNum.positive().max(1000), beatgrid: ZFloat32Base64, downbeats: ZFloat32Base64 }).strict();
const ZKeyData = z
	.object({ camelot: z.string().regex(/^(?:[1-9]|1[0-2])[AB]$/), strength: ZNumOrNull })
	.strict();
const ZSegment = z
	.object({
		startSec: ZNum.min(0),
		endSec: ZNum.min(0),
		label: z.string().min(1).max(32),
		source: z.literal('analyzer').optional(),
		confidence: ZNum.optional(),
		energy: ZNum.optional(),
	})
	.strict();
const ZStructureData = z
	.object({
		segments: z.array(ZSegment).max(5000),
		introLengthSec: ZNumOrNull,
		outroLengthSec: ZNumOrNull,
		firstDropSec: ZNumOrNull,
		dropCount: ZCount,
		breakdownCount: ZCount,
	})
	.strict();
const ZAdvancedData = z
	.object({
		brightness: ZNumOrNull,
		power: ZNumOrNull,
		dynamicComplexity: ZNumOrNull,
		loudnessRangeLu: ZNumOrNull,
		dissonance: ZNumOrNull,
		density: ZNumOrNull,
		features: z.record(z.unknown()).nullable(),
	})
	.strict();
const ZFingerprintData = z.object({ chromaprint: ZBase64.min(1), durationSec: z.number().int().min(1).max(86_400) }).strict();
const ZPeaksData = z.object({ blob: ZBlobRef, cpkVersion: z.number().int().min(1).max(255) }).strict();
const ZVectorsData = z
	.object({ blob: ZBlobRef, dim: z.number().int().min(1).max(8192), count: z.number().int().min(1).max(100_000) })
	.strict();

// ── items ───────────────────────────────────────────────────────────────────

// Licence of what the item was derived with (`mir_model.license` for vectors,
// e.g. 'CC-BY-NC-4.0'). Phase 2 honours it before sharing across users.
const ZLicence = z.string().min(1).max(64);

type ItemOf<U extends CatalogueUnit, V extends string, L = string | null> = {
	audioHash: string;
	unit: U;
	variant: V;
	version: number[];
	unitSchema: number;
	// The decoded audio's duration. A reader compares it with its own file
	// (±1 s) before trusting anything under the hash.
	durationSec: number;
	licence: L;
	data: UnitDataMap[U];
};

// One unit of analysis for one audio hash: what a device puts, and (with
// the stored fields) what lookup returns.
export type CatalogueItem =
	| ItemOf<'rhythm', 'default'>
	| ItemOf<'key', 'default'>
	| ItemOf<'structure', 'default'>
	| ItemOf<'advanced', 'default'>
	| ItemOf<'fingerprint', 'default'>
	| ItemOf<'peaks', PeaksTier>
	// variant = the model id; vectors always name their licence.
	| ItemOf<'vectors', string, string>;

const base = {
	audioHash: ZAudioHash,
	version: ZAnalysisVersion,
	unitSchema: z.number().int().min(1),
	durationSec: ZNum.positive().max(86_400),
	licence: ZLicence.nullable(),
};
const ZDefault = z.literal(DEFAULT_VARIANT);

// Inline data larger than this is refused as `invalid_item`: the biggest
// real one is a long mix's beatgrid (~80 KB of base64).
export const MAX_CATALOGUE_DATA_BYTES = 512 * 1024;

export const ZCatalogueItem = z
	.discriminatedUnion('unit', [
		z.object({ ...base, unit: z.literal('rhythm'), variant: ZDefault, data: ZRhythmData }).strict(),
		z.object({ ...base, unit: z.literal('key'), variant: ZDefault, data: ZKeyData }).strict(),
		z.object({ ...base, unit: z.literal('structure'), variant: ZDefault, data: ZStructureData }).strict(),
		z.object({ ...base, unit: z.literal('advanced'), variant: ZDefault, data: ZAdvancedData }).strict(),
		z.object({ ...base, unit: z.literal('fingerprint'), variant: ZDefault, data: ZFingerprintData }).strict(),
		z.object({ ...base, unit: z.literal('peaks'), variant: z.enum(PEAKS_TIERS), data: ZPeaksData }).strict(),
		z.object({ ...base, unit: z.literal('vectors'), variant: z.string().regex(MODEL_ID_RE), licence: ZLicence, data: ZVectorsData }).strict(),
	])
	.superRefine((item, ctx) => {
		if (item.unitSchema > CATALOGUE_UNIT_SCHEMA[item.unit]) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unitSchema'], message: `unit schema ${item.unitSchema} is newer than this server knows` });
		}
		if (utf8ByteLength(JSON.stringify(item.data)) > MAX_CATALOGUE_DATA_BYTES) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data'], message: 'data too large' });
		}
	});

export type SafeParseCatalogueItem = { ok: true; item: CatalogueItem } | { ok: false; issues: z.ZodIssue[] };

export function safeParseCatalogueItem(raw: unknown): SafeParseCatalogueItem {
	const r = ZCatalogueItem.safeParse(raw);
	return r.success ? { ok: true, item: r.data } : { ok: false, issues: r.error.issues };
}

// An item as the server holds it. `rev` orders one account's writes: it
// moves on every insert and every overwrite, so `inventory` with the last rev
// seen returns exactly what changed since.
export type StoredCatalogueItem = CatalogueItem & {
	rev: number;
	// The device that last wrote it.
	deviceId: string;
	updatedAt: number;
};

// ── server policy (the D-a / D-b switch) ────────────────────────────────────

// Which units (and, for blob units, which variants) this server accepts. A
// deployment setting, not code: D-a runs with the inline units and lo peaks
// only, D-b adds hi peaks and vectors. The server advertises it in the health
// probe and on every inventory page; a device uploads and hydrates only what
// it allows, and the server refuses the rest as `unit_disabled`.
export type CataloguePolicy = {
	// `variants: null` = any variant of that unit.
	allow: { unit: CatalogueUnit; variants: string[] | null }[];
};

export function catalogueAllows(policy: CataloguePolicy, unit: CatalogueUnit, variant: string): boolean {
	return policy.allow.some((a) => a.unit === unit && (a.variants === null || a.variants.includes(variant)));
}

// ── lookup ──────────────────────────────────────────────────────────────────

export const MAX_CATALOGUE_LOOKUP_HASHES = 50;
export const MAX_CATALOGUE_LOOKUP_WANTS = 32;

export type CatalogueWant = {
	unit: CatalogueUnit;
	// Absent: every variant (all peaks tiers, every model).
	variant?: string;
	// The reader's floor (MIN_FULL_REANALYSIS_VERSION and friends).
	minVersion?: number[];
	// The newest unit schema the reader understands.
	maxSchema?: number;
};

export type CatalogueLookupInput = {
	deviceId: string;
	audioHashes: string[];
	want: CatalogueWant[];
};

export type CatalogueLookupResult = {
	// The newest acceptable version per (hash, unit, variant) the account
	// holds; a key with nothing acceptable is simply absent.
	items: StoredCatalogueItem[];
};

const ZWant = z
	.object({
		unit: z.enum(CATALOGUE_UNITS),
		variant: ZVariant.optional(),
		minVersion: ZAnalysisVersion.optional(),
		maxSchema: z.number().int().min(1).max(1000).optional(),
	})
	.strict();

export const ZCatalogueLookupInput = z
	.object({
		deviceId: ZDeviceId,
		audioHashes: z.array(ZAudioHash).min(1).max(MAX_CATALOGUE_LOOKUP_HASHES),
		want: z.array(ZWant).min(1).max(MAX_CATALOGUE_LOOKUP_WANTS),
	})
	.strict();

// ── put ─────────────────────────────────────────────────────────────────────

// Whole-call caps, answered `batch_too_large` like a push: split and retry.
export const MAX_CATALOGUE_PUT_ITEMS = 100;
export const MAX_CATALOGUE_PUT_BYTES = 1024 * 1024;

// The server keeps this many versions per (hash, unit, variant); older ones
// are dropped and their blobs named in `superseded`.
export const CATALOGUE_VERSIONS_KEPT = 2;

export type CataloguePutInput = {
	deviceId: string;
	items: CatalogueItem[];
};

// Per-item verdicts. Permanent for that item as sent: the device does not
// retry it unchanged (after uploading a missing blob, it may).
export const CATALOGUE_REJECT_REASONS = [
	// Failed the item schema (shape, sizes, unit schema newer than the server).
	'invalid_item',
	// The server's policy does not accept this unit/variant (D-b off).
	'unit_disabled',
	// `blob.path` is not `catalogueBlobPath(<caller>, unit, blob.sha256)`.
	'blob_path_invalid',
	// No such object in the caller's Storage prefix: upload first.
	'blob_missing',
	// The object exists but its size is not `blob.bytes`.
	'blob_size_mismatch',
	// Storing it would take the account past its quota.
	'quota_exceeded',
	// The account already holds CATALOGUE_VERSIONS_KEPT newer versions.
	'version_outdated',
	// The same (hash, unit, variant, version) appears later in the batch,
	// which wins.
	'duplicate_in_batch',
] as const;
export type CatalogueRejectReason = (typeof CATALOGUE_REJECT_REASONS)[number];

export type CatalogueUsage = {
	// Inline data bytes plus referenced blob bytes, over every stored item.
	usedBytes: number;
	quotaBytes: number;
};

export type CataloguePutResult = {
	// By position in `items`, with the rev it was stored at.
	accepted: { index: number; rev: number }[];
	rejected: { index: number; reason: CatalogueRejectReason }[];
	// Blob paths no stored item references any more (versions past the kept
	// two, or a version overwritten with a different blob): the device
	// deletes them from Storage. Content-addressed, so a path still used by
	// another item is never listed.
	superseded: string[];
	usage: CatalogueUsage;
};

// ── inventory ───────────────────────────────────────────────────────────────

export const MAX_CATALOGUE_INVENTORY = 5000;

export type CatalogueInventoryInput = {
	deviceId: string;
	afterRev: number;
	// Capped at MAX_CATALOGUE_INVENTORY, not refused.
	limit?: number;
};

export type CatalogueInventoryEntry = {
	audioHash: string;
	unit: CatalogueUnit;
	variant: string;
	version: number[];
	unitSchema: number;
	rev: number;
	// Inline data plus blob bytes: what a hydrate of it costs.
	bytes: number;
	deviceId: string;
};

export type CatalogueAccount = CatalogueUsage & {
	// False until the owner adds the account to curator.catalogue_account:
	// lookups work (on nothing), puts and uploads are refused.
	entitled: boolean;
};

export type CatalogueInventoryResult = {
	// Ordered by rev. Retention deletes are not reported: a dropped version
	// always has a newer one above it in rev order.
	entries: CatalogueInventoryEntry[];
	// The last rev returned, or `afterRev` when the page is empty.
	nextRev: number;
	more: boolean;
	account: CatalogueAccount;
	policy: CataloguePolicy;
};

export const ZCatalogueInventoryInput = z
	.object({
		deviceId: ZDeviceId,
		afterRev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		limit: z.number().int().positive().optional(),
	})
	.strict();

// The schemas and the protocol types must describe the same values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _item: Same<z.infer<typeof ZCatalogueItem>, CatalogueItem> = true;
const _lookup: Same<z.infer<typeof ZCatalogueLookupInput>, CatalogueLookupInput> = true;
const _inventory: Same<z.infer<typeof ZCatalogueInventoryInput>, CatalogueInventoryInput> = true;
const _blob: Same<z.infer<typeof ZBlobRef>, BlobRef> = true;
void _item;
void _lookup;
void _inventory;
void _blob;
