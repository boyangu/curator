import { describe, expect, it } from 'vitest';
import { ZCatalogBrowseInput, ZCatalogTracksInput, type CatalogClaim } from './catalog-service.js';
import { ZCatalogDeviceProfile } from './catalog-work.js';
import { parseWorkResult, ZCatalogWorkReportWire } from './catalog-work-report.js';

const DEVICE = '0b9f6f6e-6c0b-4f43-8a51-5d9a3f1c2e10';
const OBJECT = '75db776e-df95-4b02-b243-6ad2171696e1';
const profile = { form: 'phone', reader: 1, stores: ['spotify', 'deezer'] };
const release: CatalogClaim = { provider: 'beatport', kind: 'release', providerId: '123', name: 'Salvage', url: 'https://www.beatport.com/release/salvage/123' };

describe('the device profile', () => {
	it('rides on a read only as a known shape', () => {
		expect(ZCatalogDeviceProfile.safeParse(profile).success).toBe(true);
		expect(ZCatalogDeviceProfile.safeParse({ ...profile, stores: [] }).success).toBe(true);
		// Tidal is the cloud's to ask, never a device's.
		expect(ZCatalogDeviceProfile.safeParse({ ...profile, stores: ['tidal'] }).success).toBe(false);
		expect(ZCatalogDeviceProfile.safeParse({ ...profile, form: 'tablet' }).success).toBe(false);
		expect(ZCatalogBrowseInput.safeParse({ deviceId: DEVICE, id: OBJECT, brief: true, profile, hints: [{ provider: 'spotify', kind: 'artist', providerId: '6ybV5qa4sWK8lFUHb33n7S' }] }).success).toBe(true);
		expect(ZCatalogTracksInput.safeParse({ deviceId: DEVICE, id: OBJECT, profile: { ...profile, visit: { id: 'visit-0001', round: 1, taken: 3 } } }).success).toBe(true);
	});

	it('a read without one stays what it was', () => {
		expect(ZCatalogBrowseInput.safeParse({ deviceId: DEVICE, id: OBJECT }).success).toBe(true);
	});
});

describe('a work report', () => {
	it('takes results one by one, so one bad result costs its job alone', () => {
		const wire = ZCatalogWorkReportWire.safeParse({ deviceId: DEVICE, idempotencyKey: 'visit-0001:1', profile, results: [{ anything: true }, 7], calls: { spotify: 4 } });
		expect(wire.success).toBe(true);
		const good = parseWorkResult({ jobId: `release:${OBJECT}`, kind: 'release', found: [{ how: 'isrc', claim: release }], notFound: ['deezer'], checks: [] });
		expect(good.ok).toBe(true);
		const bad = parseWorkResult({ jobId: `release:${OBJECT}`, kind: 'release', found: [{ how: 'guess', claim: release }], notFound: [], checks: [] });
		expect(bad).toMatchObject({ ok: false, jobId: `release:${OBJECT}` });
		expect(parseWorkResult(7)).toMatchObject({ ok: false, jobId: null });
	});

	it('a store that did not answer is its own result', () => {
		expect(parseWorkResult({ jobId: `facts:${OBJECT}`, kind: 'error', store: 'beatport', message: 'blocked', rateLimitedSec: 3600 }).ok).toBe(true);
		expect(parseWorkResult({ jobId: `facts:${OBJECT}`, kind: 'error', store: 'tidal', message: 'x', rateLimitedSec: null }).ok).toBe(false);
	});

	it('facts name the recording and carry the store claim', () => {
		const row = { recordingId: OBJECT, claim: { provider: 'beatport', kind: 'recording', providerId: '9', name: 'Salvage', url: 'https://www.beatport.com/track/salvage/9', facts: { bpm: 125, key: 'A Minor' } } };
		expect(parseWorkResult({ jobId: `facts:${OBJECT}`, kind: 'facts', rows: [row], notFound: [{ recordingId: OBJECT, store: 'traxsource' }] }).ok).toBe(true);
		expect(parseWorkResult({ jobId: `facts:${OBJECT}`, kind: 'facts', rows: [{ ...row, recordingId: 'not-an-id' }], notFound: [] }).ok).toBe(false);
	});
});
