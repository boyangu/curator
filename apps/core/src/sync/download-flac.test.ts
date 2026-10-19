// Atomic-write coverage for the 2026-07-26 partial-import incident: the
// downloader streamed straight to the final path inside a watched folder, and
// rekordbox auto-imported the file 41s before the last byte landed — minting
// an artist-less row from a truncated FLAC. The invariant pinned here: the
// final outputPath either doesn't exist or holds a complete, valid FLAC.
// Everything in-flight lives at `<outputPath>.part`, and a failed download
// leaves neither file behind.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFlac } from './download-flac.js';

let dir: string;

// Minimal init segment: one box `[size=50]['dfLa'][blockHeader=0x22][STREAMINFO×34]`
// with a STREAMINFO encoding 44100 Hz / 2ch / 16-bit so validateStreamInfo passes.
function buildInitSegment(): Buffer {
	const buf = Buffer.alloc(50);
	buf.writeUInt32BE(50, 0);
	buf.write('dfLa', 4, 'ascii');
	buf.writeUInt32BE(0x00000022, 12);
	const streamInfoAt = 16;
	// bytes 10..13 of STREAMINFO: sampleRate(20b)=44100, channels-1(3b)=1, bps-1(5b)=15
	buf.writeUInt32BE((44100 << 12) | (1 << 9) | (15 << 4), streamInfoAt + 10);
	return buf;
}

// Media segment: a single mdat box whose payload stands in for FLAC frames.
function buildMediaSegment(payload: Buffer): Buffer {
	const buf = Buffer.alloc(8 + payload.length);
	buf.writeUInt32BE(8 + payload.length, 0);
	buf.write('mdat', 4, 'ascii');
	payload.copy(buf, 8);
	return buf;
}

const MANIFEST_XML =
	'<MPD><SegmentTemplate initialization="http://cdn.test/init" media="http://cdn.test/seg$Number$" startNumber="1"><S d="1000"/></SegmentTemplate></MPD>';
const MANIFEST_B64 = Buffer.from(MANIFEST_XML, 'utf8').toString('base64');

function stubFetch(handlers: Record<string, () => Response>): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const h = handlers[url];
		if (!h) throw new Error(`unexpected fetch: ${url}`);
		return h();
	}));
}

function ok(body: Buffer): Response {
	return new Response(new Uint8Array(body), { status: 200 });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-dl-'));
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe('downloadFlac atomic write', () => {
	it('publishes the final path only after the stream completes, with no .part left', async () => {
		const outputPath = join(dir, 'Artist - Title.flac');
		const frames = Buffer.from('fake-flac-frames');
		stubFetch({
			'http://cdn.test/init': () => ok(buildInitSegment()),
			'http://cdn.test/seg1': () => ok(buildMediaSegment(frames)),
		});

		const result = await downloadFlac({
			manifestBase64: MANIFEST_B64,
			outputPath,
			metadata: { TITLE: 'Title', ARTIST: 'Artist' },
		});

		expect(existsSync(outputPath)).toBe(true);
		expect(existsSync(`${outputPath}.part`)).toBe(false);
		const written = readFileSync(outputPath);
		expect(result.bytes).toBe(written.length);
		expect(written.subarray(0, 4).toString('ascii')).toBe('fLaC');
		expect(written.subarray(written.length - frames.length).equals(frames)).toBe(true);
	});

	it('leaves neither the final file nor the .part behind when a segment fails', async () => {
		const outputPath = join(dir, 'Artist - Broken.flac');
		stubFetch({
			'http://cdn.test/init': () => ok(buildInitSegment()),
			'http://cdn.test/seg1': () => new Response(null, { status: 404 }),
		});

		await expect(
			downloadFlac({ manifestBase64: MANIFEST_B64, outputPath })
		).rejects.toThrow();

		expect(readdirSync(dir)).toEqual([]);
	});
});
