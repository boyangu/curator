import { describe, it, expect } from 'vitest';
import { extractRemixers, applyRemixers, formatTrackTitle } from './remix-credit.js';
import { withFormatTag } from './format-tag.js';
import { searchFold } from './search.js';

const known = (...names: string[]) => { const s = new Set(names.map(searchFold)); return (f: string) => s.has(f); };

describe('extractRemixers', () => {
	it('reads bracketed and dash-tail remix segments, keeping the title untouched', () => {
		expect(extractRemixers('Callisto - Ben Böhmer Remix')).toEqual(['Ben Böhmer']);
		expect(extractRemixers('Drown (Massano Remix)')).toEqual(['Massano']);
		expect(extractRemixers('Elephant Shunned - Solee Extended Remix')).toEqual(['Solee']);
		expect(extractRemixers('LoveHate Thing (feat. Sam Dew) [Marten Lou Remix]')).toEqual(['Marten Lou']);
	});

	it('never mints an artist from a weak word alone', () => {
		expect(extractRemixers('Radian - Cercle Version')).toEqual([]);
		expect(extractRemixers('Try It Out - Neon Mix')).toEqual([]);
		expect(extractRemixers('Toy Soldiers - Japanese Version')).toEqual([]);
		expect(extractRemixers('Track - Original Mix')).toEqual([]);
		expect(extractRemixers('Track (Extended Mix)')).toEqual([]);
		expect(extractRemixers('Track - Radio Edit')).toEqual([]);
		expect(extractRemixers('Track - Instrumental Album Version')).toEqual([]);
		// …but a KNOWN artist with a weak word is a credit.
		expect(extractRemixers('Breezeblocks (Tinlicker Extended Mix)', { known: known('Tinlicker') })).toEqual(['Tinlicker']);
		expect(extractRemixers('From Afar - Makebo Extended Mix', { credits: [{ name: 'Makebo' }] })).toEqual(['Makebo']);
	});

	it('resolves named remixes and possessives to the known artist', () => {
		expect(extractRemixers('All I Need - Ae:ther Dreaming Dub Remix', { known: known('Ae:ther') })).toEqual(['Ae:ther']);
		expect(extractRemixers('Reflets (Rodriguez Jr. Evocation Remix)', { known: known('Rodriguez Jr.') })).toEqual(['Rodriguez Jr.']);
		expect(extractRemixers('Box of Birds (Perfect Stranger 2023 remix)', { known: known('Perfect Stranger') })).toEqual(['Perfect Stranger']);
		expect(extractRemixers("The Question - Milio's 7am Dub Mix", { known: known('Milio') })).toEqual(['Milio']);
		expect(extractRemixers("Philanthropy - Stephan Barnem's Endless Remix", { known: known('Stephan Barnem') })).toEqual(['Stephan Barnem']);
		// Unknown possessive owner after a weak word → nothing.
		expect(extractRemixers("Sing It Back (Herbert's Tasteful Dub)")).toEqual([]);
	});

	it('accepts a short unknown name only after a strong word', () => {
		expect(extractRemixers('Shukran City - Mula Remix')).toEqual(['Mula']);
		expect(extractRemixers('Chanda (AmuAmu Remix)')).toEqual(['AmuAmu']);
		expect(extractRemixers('Mysterious Conversation - Tanzmann & Stefanik Remix')).toEqual(['Tanzmann & Stefanik']);
		expect(extractRemixers("Liebe - donnerstag's Lost in Space Remix")).toEqual([]);
		expect(extractRemixers('The Damned - 2021 Raw Edit')).toEqual([]);
		expect(extractRemixers('Stories In Light - Extended Streaming Mix')).toEqual([]);
		expect(extractRemixers('What Is Real - Deep in the Playa Mix')).toEqual([]);
	});

	it('prefers the library spelling of a bare country tag and handles curly possessives', () => {
		expect(extractRemixers('Shiver - Ivory IT Remix', { known: known('Ivory (IT)') })).toEqual(['Ivory (IT)']);
		expect(extractRemixers('Shiver - Ivory IT Remix')).toEqual(['Ivory IT']);
		expect(extractRemixers('Levo - Recondite‘s Remix', { known: known('Recondite') })).toEqual(['Recondite']);
		expect(extractRemixers('Levo - Recondite’s Late Night Mix', { known: known('Recondite') })).toEqual(['Recondite']);
	});

	it('splits a pair only when both halves are known', () => {
		expect(extractRemixers('Atlas - Shall Ocin & Artbat Remix', { known: known('Shall Ocin', 'ARTBAT') })).toEqual(['Shall Ocin', 'Artbat']);
		expect(extractRemixers('Amida - Satori & El Mundo Remix', { known: known('Satori') })).toEqual(['Satori']);
		expect(extractRemixers('X - Frankey & Sandrino Remix', { known: known('Frankey & Sandrino') })).toEqual(['Frankey & Sandrino']);
		expect(extractRemixers('A - B, C Remix', { known: known('B', 'C') })).toEqual(['B', 'C']);
	});
});

describe('formatTrackTitle', () => {
	const rmx = (n: string) => ({ name: n, role: 'remixer' as const });
	it('re-wraps the release remix segment in the chosen style, wording intact', () => {
		expect(formatTrackTitle('Feel Me - JAMIEE Remix', [{ name: 'Liminal MX' }, rmx('JAMIEE')], 'parenthesis')).toBe('Feel Me (JAMIEE Remix)');
		expect(formatTrackTitle('Feel Me (JAMIEE Remix)', [{ name: 'Liminal MX' }, rmx('JAMIEE')], 'dash')).toBe('Feel Me - JAMIEE Remix');
		expect(formatTrackTitle('Elephant Shunned - Solee Extended Remix', [{ name: 'A' }, rmx('Solee')], 'parenthesis')).toBe('Elephant Shunned (Solee Extended Remix)');
		expect(formatTrackTitle('LoveHate Thing (feat. Sam Dew) [Marten Lou Remix]', [{ name: 'A' }, rmx('Marten Lou')], 'dash')).toBe('LoveHate Thing (feat. Sam Dew) - Marten Lou Remix');
		expect(formatTrackTitle("The Question - Milio's 7am Dub Mix", [{ name: 'A' }, rmx('Milio')], 'parenthesis')).toBe("The Question (Milio's 7am Dub Mix)");
	});
	it('keeps a converted copy\'s format tag last', () => {
		expect(formatTrackTitle('Feel Me - JAMIEE Remix [WAV]', [{ name: 'Liminal MX' }, rmx('JAMIEE')], 'parenthesis')).toBe('Feel Me (JAMIEE Remix) [WAV]');
		expect(formatTrackTitle('Plain [WAV]', [{ name: 'A' }, rmx('X')], 'dash')).toBe('Plain - X Remix [WAV]');
		expect(formatTrackTitle('Plain [WAV]', [{ name: 'A' }], 'dash')).toBe('Plain [WAV]');
		expect(withFormatTag('Song (X Remix) [WAV]', 'WAV')).toBe('Song (X Remix) [WAV]');
		expect(withFormatTag('Song (X Remix)', 'WAV')).toBe('Song (X Remix) [WAV]');
	});
	it('leaves titles alone without a remixer credit, and non-remix segments in place', () => {
		expect(formatTrackTitle('Track - Original Mix', [{ name: 'A' }], 'parenthesis')).toBe('Track - Original Mix');
		expect(formatTrackTitle('Track (Original Mix) - X Remix', [{ name: 'A' }, rmx('X')], 'parenthesis')).toBe('Track (Original Mix) (X Remix)');
		expect(formatTrackTitle('Plain', [{ name: 'A' }, rmx('X')], 'dash')).toBe('Plain - X Remix');
	});
	it('reads every name of a collaboration segment as mentioned', () => {
		expect(formatTrackTitle('Paper Lantern (Orin Vale & Teo Mar Remix)', [{ name: 'Kade Lumi' }, rmx('Orin Vale'), rmx('Teo Mar')], 'parenthesis')).toBe('Paper Lantern (Orin Vale & Teo Mar Remix)');
		expect(formatTrackTitle('Driftwood (Ilo & Sev Remix)', [{ name: 'Pell Arno' }, rmx('Ilo'), rmx('Sev')], 'dash')).toBe('Driftwood - Ilo & Sev Remix');
		// Second name first: the segment is still the remixers' own.
		expect(formatTrackTitle('Home - Ajna & Samm Remix', [{ name: 'CamelPhat' }, rmx('Samm')], 'parenthesis')).toBe('Home (Ajna & Samm Remix)');
		expect(formatTrackTitle('You (Frankey & Sandrino Remix)', [{ name: 'Eelke Kleijn' }, rmx('Frankey & Sandrino')], 'parenthesis')).toBe('You (Frankey & Sandrino Remix)');
		// A remixer the segment does not name still gets their credit.
		expect(formatTrackTitle('Track (A & B Remix)', [{ name: 'M' }, rmx('A'), rmx('C')], 'parenthesis')).toBe('Track (A & B Remix) (C Remix)');
	});
	it('reads a comma list with a bracketed name as one segment, and drops the copies earlier pushes appended', () => {
		const credits = [{ name: 'Pell Arno' }, rmx('Velik'), rmx('Orrin (NL)')];
		expect(formatTrackTitle('Quiet Hours - Velik, Orrin (NL) Remix', credits, 'parenthesis')).toBe('Quiet Hours (Velik, Orrin (NL) Remix)');
		// What rekordbox held after one doubling push, and after the next.
		expect(formatTrackTitle('Quiet Hours (Velik, Orrin (NL) Remix) (Orrin (NL) Remix)', credits, 'parenthesis')).toBe('Quiet Hours (Velik, Orrin (NL) Remix)');
		expect(formatTrackTitle('Quiet Hours (Velik, Orrin (NL) Remix) (Orrin (NL) Remix) (Velik Remix) (Orrin (NL) Remix)', credits, 'parenthesis')).toBe('Quiet Hours (Velik, Orrin (NL) Remix)');
		expect(formatTrackTitle('Quiet Hours (Velik, Orrin (NL) Remix)', credits, 'dash')).toBe('Quiet Hours - Velik, Orrin (NL) Remix');
	});
	it('unwraps doubled brackets, looks inside a group that is not a remix, and heals an emptied "()"', () => {
		expect(formatTrackTitle('Rain Line ((Sora Dune remix))', [{ name: 'A' }, rmx('Sora Dune')], 'parenthesis')).toBe('Rain Line (Sora Dune remix)');
		expect(formatTrackTitle('Rain Line (Night Set (Sora Dune Remix))', [{ name: 'A' }, rmx('Sora Dune')], 'dash')).toBe('Rain Line (Night Set) - Sora Dune Remix');
		expect(formatTrackTitle('Rain Line () (Sora Dune remix)', [{ name: 'A' }, rmx('Sora Dune')], 'parenthesis')).toBe('Rain Line (Sora Dune remix)');
	});
	it('reads every dash part and keeps hyphenated names whole', () => {
		const credits = [{ name: 'Pell Arno' }, rmx('Jean-Pell'), rmx('Ilse Marr')];
		expect(formatTrackTitle('Glass Coast (Jean-Pell Remix) (Ilse Marr Remix)', credits, 'dash')).toBe('Glass Coast - Jean-Pell Remix - Ilse Marr Remix');
		expect(formatTrackTitle('Glass Coast - Jean-Pell Remix - Ilse Marr Remix', credits, 'dash')).toBe('Glass Coast - Jean-Pell Remix - Ilse Marr Remix');
		expect(formatTrackTitle('Glass Coast - Jean-Pell Remix - Ilse Marr Remix', credits, 'parenthesis')).toBe('Glass Coast (Jean-Pell Remix) (Ilse Marr Remix)');
		// A segment with a spaced dash of its own stays bracketed: as a dash
		// part it would read back as two.
		const one = formatTrackTitle('Glass Coast (Ilse Marr Remix - Extended Version)', credits, 'dash');
		expect(one).toBe('Glass Coast (Ilse Marr Remix - Extended Version) - Jean-Pell Remix');
		expect(formatTrackTitle(one, credits, 'dash')).toBe(one);
	});

	// Property: for generated titles of the shapes releases and earlier pushes
	// produce — a release segment naming some of the remixers (one name or a
	// comma/& list, bracketed names included, in brackets or as a dash tail),
	// then copies appended one remixer at a time — formatting is a fixed point
	// and names every remixer exactly once. Made-up names, no prefix of
	// another (the matcher reads a prefix as the same name).
	it('is idempotent and names each remixer once, for generated titles', () => {
		const NAMES = ['Velik', 'Orrin (NL)', 'Jean-Pell', 'Nova [UK]', 'Sora Dune', 'Tamsin & Rook', 'Dawn Dub', 'Ilse Marr'];
		const BASES = ['Quiet Hours', 'Paper Moon', 'Glass Coast (Original Mix)', 'Drift - Live', 'Low Tide [WAV]'];
		const KINDS = ['Remix', 'Extended Remix', 'Rework', 'Remix Edit'];
		let seed = 0x5eed;
		const rand = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
		const sample = (n: number): string[] => [...NAMES].sort(() => rand() - 0.5).slice(0, n);
		const occurrences = (s: string, name: string): number => s.split(name).length - 1;
		for (let n = 0; n < 600; n++) {
			const remixers = sample(1 + Math.floor(rand() * 3));
			const named = remixers.slice(0, Math.floor(rand() * (remixers.length + 1)));
			let title = pick(BASES).replace(' [WAV]', '');
			if (named.length > 0) {
				const seg = `${named.join(rand() < 0.5 ? ', ' : ' & ')} ${pick(KINDS)}`;
				const shape = rand();
				title += shape < 0.4 ? ` (${seg})` : shape < 0.7 ? ` [${seg}]` : ` - ${seg}`;
			}
			for (let k = Math.floor(rand() * 3); k > 0; k--) title += rand() < 0.7 ? ` (${pick(remixers)} Remix)` : ` - ${pick(remixers)} Remix`;
			if (rand() < 0.2) title += ' [WAV]';
			const credits = [{ name: 'Pell Arno' }, ...remixers.map(rmx)];
			for (const style of ['parenthesis', 'dash'] as const) {
				const once = formatTrackTitle(title, credits, style);
				expect(formatTrackTitle(once, credits, style), `${title} → ${once}`).toBe(once);
				for (const r of remixers) expect(occurrences(once, r), `${r} in ${once}`).toBe(1);
			}
		}
	});
});

describe('applyRemixers', () => {
	it('tags an existing credit and appends a missing one; title is not touched', () => {
		const list = [{ name: 'Lane 8' }, { name: 'Massano' }];
		expect(applyRemixers(list, 'Drown (Massano Remix)')).toEqual([{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' }]);
		expect(applyRemixers([{ name: 'Lane 8' }], 'Drown (Massano Remix)', { known: known('Massano') })).toEqual([{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' }]);
	});

	it('returns the same instance when nothing changes, and never demotes the only main credit', () => {
		const same = [{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' as const }];
		expect(applyRemixers(same, 'Drown (Massano Remix)')).toBe(same);
		const solo = [{ name: 'Lane 8' }];
		expect(applyRemixers(solo, 'Brightest Lights (Lane 8 Remix)')).toBe(solo);
		const plain = [{ name: 'Lane 8' }];
		expect(applyRemixers(plain, 'Brightest Lights')).toBe(plain);
	});

	it('leaves an explicit main role alone', () => {
		const list = [{ name: 'A', role: 'main' as const }, { name: 'B' }];
		expect(applyRemixers(list, 'T (A Remix)')).toBe(list);
	});
});
