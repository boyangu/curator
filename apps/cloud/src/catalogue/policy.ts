// The D-a / D-b switch: which catalogue units (and blob variants) this server
// accepts, from the CURATOR_CATALOGUE setting (fly.toml [env]). Staging the
// catalogue on Supabase Free (decision Q1, 2026-10-19) is a change of this
// string, not of code: D-a stores the inline units and lo peaks (~0.49 GB),
// D-b adds hi peaks and vectors once the project has the room.
//
// Grammar: comma-separated `unit` (any variant) or `unit:variant` entries,
// e.g. `rhythm,key,peaks:lo`. `off` or empty = no catalogue: the procedures
// answer `catalogue_disabled` and the health probe leaves 'catalogue' out of
// `features`, so devices never call them.

import { CATALOGUE_UNITS, VARIANT_RE, type CatalogueUnit, type CataloguePolicy } from '@curator/protocol';

export const CATALOGUE_POLICY_D_A = 'rhythm,key,structure,advanced,fingerprint,peaks:lo';
export const CATALOGUE_POLICY_D_B = 'rhythm,key,structure,advanced,fingerprint,peaks:lo,peaks:hi,vectors';

export class CataloguePolicyError extends Error {
	override readonly name = 'CataloguePolicyError';
}

export function parseCataloguePolicy(spec: string | undefined): CataloguePolicy | null {
	const s = (spec ?? '').trim();
	if (s === '' || s === 'off') return null;
	const byUnit = new Map<CatalogueUnit, Set<string> | null>();
	for (const raw of s.split(',')) {
		const entry = raw.trim();
		if (entry === '') continue;
		const [unit, variant, extra] = entry.split(':');
		if (extra !== undefined || !CATALOGUE_UNITS.includes(unit as CatalogueUnit)) {
			throw new CataloguePolicyError(`CURATOR_CATALOGUE: unknown entry "${entry}" (units: ${CATALOGUE_UNITS.join(', ')})`);
		}
		const u = unit as CatalogueUnit;
		if (variant === undefined) {
			byUnit.set(u, null);
			continue;
		}
		if (!VARIANT_RE.test(variant)) throw new CataloguePolicyError(`CURATOR_CATALOGUE: bad variant in "${entry}"`);
		const have = byUnit.get(u);
		if (have === null) continue;
		byUnit.set(u, new Set([...(have ?? []), variant]));
	}
	if (byUnit.size === 0) return null;
	// Protocol order, so the advertised policy reads the same whatever order
	// the setting was written in.
	return {
		allow: CATALOGUE_UNITS.filter((u) => byUnit.has(u)).map((u) => {
			const v = byUnit.get(u);
			return { unit: u, variants: v ? [...v].sort() : null };
		}),
	};
}
