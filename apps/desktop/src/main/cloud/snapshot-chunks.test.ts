import { describe, expect, it } from 'vitest';
import { SNAPSHOT_ENCODING, type BootstrapResult, type SnapshotChunkResult } from '@curator/protocol';
import { readSnapshotBody } from './snapshot-chunks.js';

const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const head = (chunked: boolean): BootstrapResult => (chunked
	? { snapshot: '', snapshotSeq: 7, encoding: SNAPSHOT_ENCODING, chunked: { totalBytes: body.length } }
	: { snapshot: body.toString('base64'), snapshotSeq: 7, encoding: SNAPSHOT_ENCODING });
const serve = (calls: Array<[number, number]>, cut = 0) => async (offset: number, length: number): Promise<SnapshotChunkResult> => {
	calls.push([offset, length]);
	return { snapshotSeq: 7, offset, data: body.subarray(offset, offset + length - cut).toString('base64'), totalBytes: body.length };
};

describe('readSnapshotBody', () => {
	it('joins the pieces of a chunked bootstrap into the inline body', async () => {
		const calls: Array<[number, number]> = [];
		const got = await readSnapshotBody(head(true), serve(calls), 10_000, 300);
		expect(got.equals(body)).toBe(true);
		expect(calls).toEqual([[0, 300], [300, 300], [600, 300], [900, 100]]);
		expect((await readSnapshotBody(head(false), serve([]), 10_000)).equals(body)).toBe(true);
	});
	it('refuses a short body and one past the cap', async () => {
		await expect(readSnapshotBody(head(true), serve([], 1), 10_000, 300)).rejects.toThrow(/short/);
		await expect(readSnapshotBody(head(true), serve([]), 999, 300)).rejects.toThrow(/past the cap/);
	});
});
