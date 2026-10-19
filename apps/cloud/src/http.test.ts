import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, MAX_BODY_BYTES, readBody } from './http.js';

describe('readBody', () => {
	it('concatenates chunks under the cap', async () => {
		const body = await readBody(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]));
		expect(body.toString()).toBe('{"a":1}');
	});

	it('stops reading once the cap is passed', async () => {
		const chunk = Buffer.alloc(64 * 1024);
		const many = Readable.from(Array.from({ length: Math.ceil(MAX_BODY_BYTES / chunk.length) + 1 }, () => chunk));
		await expect(readBody(many)).rejects.toBeInstanceOf(BodyTooLargeError);
		await expect(readBody(Readable.from([Buffer.alloc(11)]), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
	});
});
