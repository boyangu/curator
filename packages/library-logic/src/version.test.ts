import { describe, it, expect } from 'vitest';
import { versionOf } from './version.js';

describe('versionOf', () => {
	it('reads the same version from the dash and the bracket spelling', () => {
		expect(versionOf('Foo - Radio Edit')).toBe('radio edit');
		expect(versionOf('Foo (Radio Edit)')).toBe('radio edit');
	});

	it('treats Original Mix and a bare title as no version', () => {
		expect(versionOf('Foo')).toBe('');
		expect(versionOf('Foo - Original Mix')).toBe('');
	});

	it('ignores featured-artist credits', () => {
		expect(versionOf('Foo (feat. X)')).toBe('');
		expect(versionOf('Foo (feat. X) - Extended Mix')).toBe('extended mix');
	});

	it('keeps a remix apart from the original it shares a title with', () => {
		expect(versionOf('More - Klangkarussell Extended Remix')).not.toBe(versionOf('More'));
	});
});
