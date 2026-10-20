import { catalogueAllows } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';
import { CATALOGUE_POLICY_D_A, CATALOGUE_POLICY_D_B, parseCataloguePolicy } from './policy.js';

const env = { DATABASE_URL: 'postgres://x@localhost/db', SUPABASE_URL: 'https://p.supabase.co' };

describe('catalogue policy setting', () => {
	it('D-a: inline units and lo peaks; hi peaks and vectors refused', () => {
		const p = parseCataloguePolicy(CATALOGUE_POLICY_D_A)!;
		for (const u of ['rhythm', 'key', 'structure', 'advanced', 'fingerprint'] as const) expect(catalogueAllows(p, u, 'default')).toBe(true);
		expect(catalogueAllows(p, 'peaks', 'lo')).toBe(true);
		expect(catalogueAllows(p, 'peaks', 'hi')).toBe(false);
		expect(catalogueAllows(p, 'vectors', 'mert-v2-fullsong@1')).toBe(false);
	});

	it('D-b: everything', () => {
		const p = parseCataloguePolicy(CATALOGUE_POLICY_D_B)!;
		expect(catalogueAllows(p, 'peaks', 'hi')).toBe(true);
		expect(catalogueAllows(p, 'vectors', 'clap@1')).toBe(true);
	});

	it('normalises order, whitespace and overlaps', () => {
		expect(parseCataloguePolicy(' peaks:lo , key,peaks:hi ,')).toEqual({
			allow: [
				{ unit: 'key', variants: null },
				{ unit: 'peaks', variants: ['hi', 'lo'] },
			],
		});
		// A bare unit means every variant, whatever else names it.
		expect(parseCataloguePolicy('peaks:lo,peaks')).toEqual({ allow: [{ unit: 'peaks', variants: null }] });
	});

	it('is off when unset, empty or "off"', () => {
		for (const s of [undefined, '', '  ', 'off', ',']) expect(parseCataloguePolicy(s)).toBeNull();
	});

	it('fails the boot on a typo rather than silently dropping a unit', () => {
		expect(() => loadConfig({ ...env, CURATOR_CATALOGUE: 'rhythm,peak:lo' })).toThrow(ConfigError);
		expect(() => loadConfig({ ...env, CURATOR_CATALOGUE: 'peaks:LO' })).toThrow(ConfigError);
		expect(() => loadConfig({ ...env, CURATOR_CATALOGUE: 'peaks:lo:x' })).toThrow(ConfigError);
		expect(loadConfig({ ...env, CURATOR_CATALOGUE: CATALOGUE_POLICY_D_A }).catalogue).toEqual(parseCataloguePolicy(CATALOGUE_POLICY_D_A));
		expect(loadConfig(env).catalogue).toBeNull();
	});
});
