import { describe, expect, it } from 'vitest';
import { fitProbe, scoreRow } from './model.js';

// Synthetic library: 3 features, "quality" = +f0 - f1 (f2 is noise). Pairs
// are judged by that latent plus a little noise.
function library(n: number, seed = 7): { rows: (number | null)[][]; latent: number[] } {
	let s = seed;
	const rand = (): number => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
	const rows: (number | null)[][] = [];
	const latent: number[] = [];
	for (let i = 0; i < n; i++) {
		const f = [rand() * 10, rand() * 4, rand() * 100];
		rows.push(f);
		latent.push(f[0]! - 2 * f[1]! + (rand() - 0.5));
	}
	return { rows, latent };
}

describe('fitProbe', () => {
	it('recovers the judged direction and scores the library consistently', () => {
		const { rows, latent } = library(120);
		const pairs = [];
		let s = 3;
		const rand = (): number => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
		for (let k = 0; k < 150; k++) {
			const a = Math.floor(rand() * rows.length), b = Math.floor(rand() * rows.length);
			if (a === b) continue;
			const d = latent[a]! - latent[b]!;
			pairs.push({ a, b, y: Math.abs(d) < 0.2 ? 0.5 : d > 0 ? 1 : 0 });
		}
		const fit = fitProbe(rows, pairs, 3);
		expect(fit.weights[0]).toBeGreaterThan(0);
		expect(fit.weights[1]).toBeLessThan(0);
		expect(Math.abs(fit.weights[2]!)).toBeLessThan(Math.abs(fit.weights[0]!) / 3);
		expect(fit.trainAccuracy!).toBeGreaterThan(0.85);
		expect(fit.cvAccuracy!).toBeGreaterThan(0.8);
		// Scores order like the latent.
		const idx = rows.map((_, i) => i).sort((x, y) => fit.scores[y]! - fit.scores[x]!);
		const top = idx.slice(0, 20).reduce((sum, i) => sum + latent[i]!, 0) / 20;
		const bottom = idx.slice(-20).reduce((sum, i) => sum + latent[i]!, 0) / 20;
		expect(top).toBeGreaterThan(bottom + 5);
		// A fresh row scores through the stored parameters the same way.
		expect(scoreRow(rows[0]!, fit.mean, fit.std, fit.weights)).toBeCloseTo(fit.scores[0]!, 9);
	});

	it('handles nulls, ties only and tiny inputs without blowing up', () => {
		const rows = [[1, null, 3], [null, 2, 3], [2, 2, null]];
		const fit = fitProbe(rows, [{ a: 0, b: 1, y: 0.5 }], 3);
		expect(fit.weights.every((w) => Number.isFinite(w))).toBe(true);
		expect(fit.trainAccuracy).toBeNull();
		expect(fit.cvAccuracy).toBeNull();
		expect(fitProbe([], [], 3).scores.length).toBe(0);
	});
});
