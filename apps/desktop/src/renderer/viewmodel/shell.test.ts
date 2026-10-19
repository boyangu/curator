// Player-chrome derivations — one rule: the docked player always shows the
// right surface for the PLAYING track. The variant follows the track's
// backend, dock + big-mode gate follow the variant, presence hides the strip
// until a first load, and the chip fires only on an origin-context mismatch.
// These pin the cases that used to diverge when variant, dock, and chip each
// answered to a different authority (backend vs current tab vs play-time
// origin): omnibar cross-source plays, pinned/JIT scopes, tag views, and
// downloaded Spotify tracks.
//
// The rules are tested through the pure derive* helpers (not the live memos)
// so they run without the Solid reactive runtime — the memos are thin
// wrappers that just feed these the current signals.

import { describe, expect, it } from 'vitest';
import {
	deriveBigPlayerAllowed,
	deriveChipVisible,
	deriveEffectiveVariant,
	derivePlayerDock,
	derivePlayerPresence,
	deriveTabContext,
} from './shell.js';

describe('deriveTabContext', () => {
	it('classes the streaming catalogs and Discover as streaming, DJ-prep tabs as dj', () => {
		expect(deriveTabContext({ view: 'tracks', source: 'spotify' })).toBe('streaming');
		expect(deriveTabContext({ view: 'tracks', source: 'tidal' })).toBe('streaming');
		expect(deriveTabContext({ view: 'tracks', source: 'rekordbox' })).toBe('dj');
		expect(deriveTabContext({ view: 'tracks', source: 'rekordbox' })).toBe('dj');
		expect(deriveTabContext({ view: 'discover', source: 'rekordbox' })).toBe('streaming');
	});

	it('tag views fall through to the latent source tab', () => {
		// Only consulted for the idle fallback + the chip comparison — never
		// user-visible while a track is playing (the track decides then).
		expect(deriveTabContext({ view: 'interested', source: 'spotify' })).toBe('streaming');
		expect(deriveTabContext({ view: 'basket', source: 'rekordbox' })).toBe('dj');
	});
});

describe('deriveEffectiveVariant', () => {
	it('follows the playing track over the current tab', () => {
		// Omnibar cross-source play: a streaming track picked while browsing
		// a DJ tab still gets the streaming transport.
		expect(deriveEffectiveVariant({ playing: 'streaming', source: 'rekordbox', view: 'tracks' })).toBe('streaming');
		// Downloaded Spotify track: runs on the local backend even when
		// played from the Spotify tab — deck strip, not transport.
		expect(deriveEffectiveVariant({ playing: 'local', source: 'spotify', view: 'tracks' })).toBe('local');
	});

	it('idle falls back to the tab context', () => {
		expect(deriveEffectiveVariant({ playing: null, source: 'spotify', view: 'tracks' })).toBe('streaming');
		expect(deriveEffectiveVariant({ playing: null, source: 'rekordbox', view: 'tracks' })).toBe('local');
		expect(deriveEffectiveVariant({ playing: null, source: 'rekordbox', view: 'discover' })).toBe('streaming');
	});
});

describe('derivePlayerDock', () => {
	it('is a pure function of the variant — streaming bottom, deck top', () => {
		expect(derivePlayerDock('streaming')).toBe('bottom');
		expect(derivePlayerDock('local')).toBe('top');
	});
});

describe('deriveBigPlayerAllowed', () => {
	it('gates on the variant, not the tab', () => {
		// A downloaded Spotify track (local backend) played from the Spotify
		// tab may go big; a streaming track on a DJ tab may not.
		expect(deriveBigPlayerAllowed('local')).toBe(true);
		expect(deriveBigPlayerAllowed('streaming')).toBe(false);
	});
});

describe('derivePlayerPresence', () => {
	it('hides the strip only while nothing has ever been loaded', () => {
		// Pause / natural end keep the player's current track set, so the
		// mirror stays non-null and the strip parks instead of vanishing.
		expect(derivePlayerPresence(null)).toBe('hidden');
		expect(derivePlayerPresence('local')).toBe('dock');
		expect(derivePlayerPresence('streaming')).toBe('dock');
	});
});

describe('deriveChipVisible', () => {
	it('is off with nothing playing or no captured origin', () => {
		expect(deriveChipVisible({ playing: null, origin: { source: 'spotify', view: 'tracks' }, source: 'rekordbox', view: 'tracks' })).toBe(false);
		expect(deriveChipVisible({ playing: 'streaming', origin: null, source: 'rekordbox', view: 'tracks' })).toBe(false);
	});

	it('fires on an origin-context mismatch, in both directions', () => {
		// Started on Spotify, now browsing Rekordbox.
		expect(deriveChipVisible({ playing: 'streaming', origin: { source: 'spotify', view: 'tracks' }, source: 'rekordbox', view: 'tracks' })).toBe(true);
		// Started on a DJ tab (local file), now browsing Discover.
		expect(deriveChipVisible({ playing: 'local', origin: { source: 'rekordbox', view: 'tracks' }, source: 'rekordbox', view: 'discover' })).toBe(true);
	});

	it('stays quiet within one context class', () => {
		// Discover → Spotify tab: both streaming.
		expect(deriveChipVisible({ playing: 'streaming', origin: { source: 'spotify', view: 'discover' }, source: 'spotify', view: 'tracks' })).toBe(false);
		// Local → Rekordbox tab: both dj.
		expect(deriveChipVisible({ playing: 'local', origin: { source: 'rekordbox', view: 'tracks' }, source: 'rekordbox', view: 'tracks' })).toBe(false);
	});

	it('compares context classes, not the backend', () => {
		// Downloaded Spotify track: local BACKEND, streaming ORIGIN. Browsing
		// a DJ tab afterwards is a genuine origin mismatch — chip on.
		expect(deriveChipVisible({ playing: 'local', origin: { source: 'spotify', view: 'tracks' }, source: 'rekordbox', view: 'tracks' })).toBe(true);
	});
});
