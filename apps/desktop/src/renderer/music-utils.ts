// Camelot key → display name + hue. Single source of truth for every key
// chip/label in the renderer — the map was previously copied into track-list.ts
// and NowPlayingCard.tsx (and a dead third copy in main.ts).
//
// Hue orientation matches the Mixed In Key / rekordbox / Serato Camelot wheel:
// Camelot 8 (C / Am) anchors at red (oklch hue ~28) and each step up the wheel
// adds +30°, wrapping the circle (red→orange→gold→green→cyan→blue→purple→
// magenta→pink as the number climbs 8→9→…→12→1→…→7). A and B of the same number
// share a hue — the chip CSS distinguishes minor (soft) from major (vivid) by
// saturation, not hue.
export const KEY_MAP: Record<string, { name: string; hue: number; mode: 'A' | 'B' }> = {
	// Musical labels are ASCII: sharps as '#', flats as lowercase 'b' (so 'Eb',
	// not 'E♭'/'EB'), minor as lowercase 'm' ('Cm'). Matches what the edit modal
	// accepts/echoes and keeps the flat 'b' visually distinct from the note 'B'.
	'1A': { name: 'G#m', hue: 178, mode: 'A' }, '1B': { name: 'B', hue: 178, mode: 'B' },
	'2A': { name: 'D#m', hue: 208, mode: 'A' }, '2B': { name: 'F#', hue: 208, mode: 'B' },
	'3A': { name: 'A#m', hue: 238, mode: 'A' }, '3B': { name: 'Db', hue: 238, mode: 'B' },
	'4A': { name: 'Fm', hue: 268, mode: 'A' }, '4B': { name: 'Ab', hue: 268, mode: 'B' },
	'5A': { name: 'Cm', hue: 298, mode: 'A' }, '5B': { name: 'Eb', hue: 298, mode: 'B' },
	'6A': { name: 'Gm', hue: 328, mode: 'A' }, '6B': { name: 'Bb', hue: 328, mode: 'B' },
	'7A': { name: 'Dm', hue: 358, mode: 'A' }, '7B': { name: 'F', hue: 358, mode: 'B' },
	'8A': { name: 'Am', hue: 28, mode: 'A' }, '8B': { name: 'C', hue: 28, mode: 'B' },
	'9A': { name: 'Em', hue: 58, mode: 'A' }, '9B': { name: 'G', hue: 58, mode: 'B' },
	'10A': { name: 'Bm', hue: 88, mode: 'A' }, '10B': { name: 'D', hue: 88, mode: 'B' },
	'11A': { name: 'F#m', hue: 118, mode: 'A' }, '11B': { name: 'A', hue: 118, mode: 'B' },
	'12A': { name: 'C#m', hue: 148, mode: 'A' }, '12B': { name: 'E', hue: 148, mode: 'B' },
};

import { uiSettingsSignal } from './features/uiSettings.js';

// Resolved key chip — the one place that turns a Camelot key into what the
// UI shows. `label` honours the user's keyDisplayFormat preference (Camelot
// '8A' vs musical 'Am'); `hue`/`mode` drive the colour and are identical
// either way. Returns null only when the key is absent or unrecognised.
//
// Reading uiSettingsSignal() here makes any Solid scope that calls this
// reactive — flip the setting and <KeyChip> re-renders for free. The vanilla
// innerHTML sites (track-list, omnibar) read it at paint time and are
// repainted by an effect in main.ts when the preference changes.
export interface ResolvedKeyChip { label: string; hue: number; mode: 'A' | 'B'; }

export function resolveKeyChip(keyCamelot: string | null | undefined): ResolvedKeyChip | null {
	if (!keyCamelot) return null;
	const km = KEY_MAP[keyCamelot];
	if (!km) return null;
	const label = uiSettingsSignal().keyDisplayFormat === 'musical' ? km.name : keyCamelot;
	return { label, hue: km.hue, mode: km.mode };
}

// BPM display. Rekordbox/analyzer BPM carries up to 2 decimals (91.13). Two
// variants by context:
//   formatBpm    — player surfaces: keep the decimals DJs match on when present
//                  (91.13), but render whole numbers cleanly (80.00 → "80"). The
//                  `Number(...toFixed(2))` round-trip also absorbs float noise
//                  from the centi-BPM /100 divide.
//   formatBpmInt — compact list rows (track list, omnibar): round to a whole
//                  number so the column stays tidy.
// Both use an em-dash placeholder to keep row/column alignment when bpm is absent.
export function formatBpm(bpm: number | null | undefined): string {
	return bpm == null ? '—' : String(Number(bpm.toFixed(2)));
}

export function formatBpmInt(bpm: number | null | undefined): string {
	return bpm == null ? '—' : String(Math.round(bpm));
}

// Chip markup for the vanilla innerHTML render sites (track-list, omnibar).
// Solid sites use the <KeyChip> component instead. Always returns a chip —
// the em-dash placeholder keeps column/row alignment when a key is missing.
export function keyChipHtml(keyCamelot: string | null | undefined): string {
	const c = resolveKeyChip(keyCamelot);
	return c
		? `<span class="key-chip key-chip--${c.mode}" style="--key-h:${c.hue}">${c.label}</span>`
		: '<span class="key-chip key-chip--empty">—</span>';
}
