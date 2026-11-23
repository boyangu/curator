// The MyTag-in-Comment block rekordbox maintains (tag-comment.ts). Strings
// below are real shapes from the user's library (2026-09-10 diagnosis).

import { describe, it, expect } from 'vitest';
import { parseTagComment, buildTagComment, tagCommentMatches } from './tag-comment.js';

describe('parseTagComment', () => {
	it('splits a tags-only block', () => {
		expect(parseTagComment(' /* ! / p1 / b1 / piano+ / melodic / dreamy / warm / sunset */'))
			.toEqual({ prefix: '', tokens: ['!', 'p1', 'b1', 'piano+', 'melodic', 'dreamy', 'warm', 'sunset'] });
	});
	it('keeps a user comment before the block', () => {
		expect(parseTagComment('Purchased at Beatport.com /* p3 / ! / b0 / house */'))
			.toEqual({ prefix: 'Purchased at Beatport.com', tokens: ['p3', '!', 'b0', 'house'] });
	});
	it('tag names may contain a slash without a surrounding space', () => {
		expect(parseTagComment(' /* prog/deep / techno */').tokens).toEqual(['prog/deep', 'techno']);
	});
	it('no block → tokens null, prefix = the comment', () => {
		expect(parseTagComment('up, warm')).toEqual({ prefix: 'up, warm', tokens: null });
		expect(parseTagComment(null)).toEqual({ prefix: '', tokens: null });
		expect(parseTagComment('')).toEqual({ prefix: '', tokens: null });
	});
});

describe('buildTagComment', () => {
	it('empty tag list leaves the comment untouched (not managed here)', () => {
		expect(buildTagComment(null, [])).toBeNull();
		expect(buildTagComment(' /* chill */', [])).toBe(' /* chill */');
		expect(buildTagComment('hello', [])).toBe('hello');
	});
	it('appends a block to a comment that has none', () => {
		expect(buildTagComment(null, ['sunset', 'house'])).toBe(' /* sunset / house */');
		expect(buildTagComment('up, warm', ['p3'])).toBe('up, warm /* p3 */');
	});
	it('keeps existing token order and appends new tags at the end', () => {
		expect(buildTagComment(' /* p3 / b0 / house */', ['house', 'b0', 'p3', 'sunset']))
			.toBe(' /* p3 / b0 / house / sunset */');
	});
	it('drops tokens whose tag was removed, replaces renamed ones', () => {
		expect(buildTagComment(' /* p3 / b2 / house */', ['p3', 'b1', 'house']))
			.toBe(' /* p3 / house / b1 */');
	});
	it('round-trips: rebuilding with the block\'s own tokens is byte-stable', () => {
		const real = 'Purchased at Beatport.com /* p3 / ! / b0 / house / prog/deep / sunset */';
		expect(buildTagComment(real, parseTagComment(real).tokens!)).toBe(real);
	});
	it('dedupes a block rekordbox left with a repeated token', () => {
		expect(buildTagComment(' /* melodic / warm / melodic */', ['melodic', 'warm'])).toBe(' /* melodic / warm */');
	});
});

describe('tagCommentMatches', () => {
	it('true when the block lists exactly the tags (any order)', () => {
		expect(tagCommentMatches(' /* p3 / b0 / house */', ['house', 'p3', 'b0'])).toBe(true);
	});
	it('false when a tag is missing, extra, or the block is absent', () => {
		expect(tagCommentMatches(' /* p3 / b0 */', ['p3', 'b0', 'sunset'])).toBe(false);
		expect(tagCommentMatches(' /* p3 / b0 / old */', ['p3', 'b0'])).toBe(false);
		expect(tagCommentMatches(null, ['p3'])).toBe(false);
	});
	it('true for an empty tag list (nothing to mirror)', () => {
		expect(tagCommentMatches(null, [])).toBe(true);
	});
});
