// The zod shapes of sync.pull's, sync.bootstrap's and the batch procedures'
// inputs: the server validates with them, and the protocol tests pin what an old and a new
// client may send. Strict, like every server input: an unknown key is
// refused rather than ignored, which is exactly why a client may only send
// the 'pull_skip_own' / 'device_reads' fields to a server that advertised
// the feature (cloud-service.ts `SYNC_FEATURES`).

import { z } from 'zod';
import {
	BATCH_LABEL_PATTERN,
	MAX_SNAPSHOT_CHUNK_BYTES,
	MAX_SNAPSHOT_PARTS,
	SNAPSHOT_PART_MAX_BYTES,
	SNAPSHOT_STORAGE_ENCODING,
	type BatchAbortInput,
	type BatchBeginInput,
	type BatchCommitInput,
	type BootstrapInput,
	type PublishSnapshotInput,
	type PullInput,
	type SnapshotChunkInput,
} from './cloud-service.js';

export const ZDeviceId = z.string().min(1).max(128);

const ZSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ZPullInput = z
	.object({
		afterSeq: ZSeq,
		// Capped at MAX_PULL_OPS by the server, not refused: asking for more is
		// not an error, the client just gets a page.
		limit: z.number().int().positive().optional(),
		deviceId: ZDeviceId.optional(),
		ownThroughSeq: ZSeq.optional(),
	})
	.strict()
	// The bound needs the device it is about. The reverse is not implied: a
	// device id alone ('device_reads') names the caller and skips nothing,
	// since "skip all my ops" is only safe for a database that holds every op
	// ever stamped with its id, which a restored backup does not.
	.refine((v) => v.ownThroughSeq === undefined || v.deviceId !== undefined, {
		message: 'ownThroughSeq needs deviceId',
		path: ['ownThroughSeq'],
	});

// `.optional()`: a client from before 'device_reads' sends no input at all.
// `chunked` only to a server with 'snapshot_chunks'.
// `storage` only to a server with 'snapshot_storage'.
export const ZBootstrapInput = z.object({ deviceId: ZDeviceId.optional(), chunked: z.literal(true).optional(), storage: z.literal(true).optional() }).strict().optional();

export const ZSnapshotChunkInput = z
	.object({
		deviceId: ZDeviceId.optional(),
		snapshotSeq: ZSeq,
		offset: ZSeq,
		length: z.number().int().positive().max(MAX_SNAPSHOT_CHUNK_BYTES),
	})
	.strict();

// 'batches'. A batch id is the server's UUID; anything else cannot name a
// batch and is refused before a query runs.
export const ZBatchId = z.string().uuid();

export const ZBatchBeginInput = z
	.object({
		deviceId: ZDeviceId,
		label: z.string().regex(BATCH_LABEL_PATTERN),
		expectedOps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	})
	.strict();

// `ops` is unknown[] like sync.push's: each op is validated on its own so one
// malformed op is rejected alone (the server checks the caps itself, to
// answer `batch_too_large`).
export const ZBatchPushInput = z.object({ deviceId: ZDeviceId, batchId: ZBatchId, ops: z.array(z.unknown()) }).strict();

export const ZBatchCommitInput = z.object({ deviceId: ZDeviceId, batchId: ZBatchId }).strict();
export const ZBatchAbortInput = z.object({ deviceId: ZDeviceId, batchId: ZBatchId }).strict();

const ZSha256 = z.string().regex(/^[0-9a-f]{64}$/);
// The shape only; that each path is snapshotPartPath(caller, sha256) and
// that the parts add up are the server's checks (`snapshot_part_invalid`).
export const ZPublishSnapshotInput = z
	.object({
		deviceId: ZDeviceId,
		snapshotSeq: ZSeq.min(1),
		manifest: z.object({
			encoding: z.literal(SNAPSHOT_STORAGE_ENCODING),
			parts: z.array(z.object({ path: z.string().min(1).max(256), bytes: z.number().int().min(1).max(SNAPSHOT_PART_MAX_BYTES), sha256: ZSha256 }).strict()).min(1).max(MAX_SNAPSHOT_PARTS),
			totalBytes: z.number().int().min(1).max(SNAPSHOT_PART_MAX_BYTES * MAX_SNAPSHOT_PARTS),
			sha256: ZSha256,
			stateSha256: ZSha256,
		}).strict(),
	})
	.strict();

// The schema and the protocol type must describe the same input.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _pullInputMatches: Same<z.infer<typeof ZPullInput>, PullInput> = true;
const _bootstrapInputMatches: Same<z.infer<typeof ZBootstrapInput>, BootstrapInput | undefined> = true;
const _chunkInputMatches: Same<z.infer<typeof ZSnapshotChunkInput>, SnapshotChunkInput> = true;
const _batchBeginMatches: Same<z.infer<typeof ZBatchBeginInput>, BatchBeginInput> = true;
const _batchCommitMatches: Same<z.infer<typeof ZBatchCommitInput>, BatchCommitInput> = true;
const _batchAbortMatches: Same<z.infer<typeof ZBatchAbortInput>, BatchAbortInput> = true;
void _batchBeginMatches;
void _batchCommitMatches;
void _batchAbortMatches;
const _publishSnapshotMatches: Same<z.infer<typeof ZPublishSnapshotInput>, PublishSnapshotInput> = true;
void _publishSnapshotMatches;
void _pullInputMatches;
void _bootstrapInputMatches;
void _chunkInputMatches;
