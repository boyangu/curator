// Catalogue items for the cloud tests: one valid item per unit, shaped like
// the desktop uploader's (packages/protocol/src/catalogue.ts), plus helpers
// for content-addressed blobs. Nothing here touches a database.

import { createHash, randomBytes } from 'node:crypto';
import { catalogueBlobPath, type BlobUnit, type CatalogueItem, type CatalogueUnit } from '@curator/protocol';

export const hashOf = (seed: string) => `pcm-md5:${createHash('md5').update(seed).digest('hex')}`;
export const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
export const randomAudioHash = () => `pcm-md5:${randomBytes(16).toString('hex')}`;

const f32 = (xs: number[]) => Buffer.from(new Float32Array(xs).buffer).toString('base64');

export type ItemOpts = { version?: number[]; variant?: string; blobSeed?: string; bytes?: number; durationSec?: number };

// `userId` places the blob path under that user's prefix, as the uploader
// does. Blob units name `sha(blobSeed)`.
export function itemFor(userId: string, unit: CatalogueUnit, audioHash: string, o: ItemOpts = {}): CatalogueItem {
	const base = { audioHash, version: o.version ?? [2, 4, 0], unitSchema: 1, durationSec: o.durationSec ?? 301.2, licence: null };
	const blob = (u: BlobUnit) => {
		const s = sha(o.blobSeed ?? `${audioHash}:${unit}:${o.variant ?? ''}:${(o.version ?? []).join('.')}`);
		return { path: catalogueBlobPath(userId, u, s), sha256: s, bytes: o.bytes ?? 4096 };
	};
	switch (unit) {
		case 'rhythm':
			return { ...base, unit, variant: 'default', data: { bpm: 126, beatgrid: f32([0.2, 0.68, 1.16, 1.64]), downbeats: f32([0.2]) } };
		case 'key':
			return { ...base, unit, variant: 'default', data: { camelot: '5A', strength: 0.77 } };
		case 'structure':
			return {
				...base,
				unit,
				variant: 'default',
				data: {
					segments: [
						{ startSec: 0, endSec: 30.5, label: 'intro', source: 'analyzer', confidence: 0.92, energy: 0.21 },
						{ startSec: 30.5, endSec: 61, label: 'drop', confidence: 0.8, energy: 0.9 },
					],
					introLengthSec: 30.5,
					outroLengthSec: null,
					firstDropSec: 30.5,
					dropCount: 1,
					breakdownCount: 0,
				},
			};
		case 'advanced':
			return {
				...base,
				unit,
				variant: 'default',
				data: {
					brightness: 0.41,
					power: 0.66,
					dynamicComplexity: 2.9,
					loudnessRangeLu: 4.4,
					dissonance: 0.47,
					density: 13.5,
					features: { lowlevel: { spectral_centroid: { mean: 1234.5 } }, rhythm: { onset_rate: 4.1 }, tags: ['a', 'ü'] },
				},
			};
		case 'fingerprint':
			return { ...base, unit, variant: 'default', data: { chromaprint: Buffer.from('chromaprint bytes').toString('base64'), durationSec: 301 } };
		case 'peaks':
			return { ...base, unit, variant: (o.variant ?? 'lo') as 'lo' | 'hi', data: { blob: blob('peaks'), cpkVersion: 3 } };
		case 'vectors':
			return {
				...base,
				version: o.version ?? [1],
				unit,
				variant: o.variant ?? 'mert-v2-fullsong@1',
				licence: 'CC-BY-NC-4.0',
				data: { blob: blob('vectors'), dim: 1024, count: 37 },
			};
	}
}

export const blobOf = (item: CatalogueItem) => (item.unit === 'peaks' || item.unit === 'vectors' ? item.data.blob : null);
