// The push gate: an op version leaves the outbox only once the server says it
// reads it (and every version below it).

import { describe, expect, it } from 'vitest';
import { pushableSchemaVersion } from './features.js';

describe('pushableSchemaVersion', () => {
	it('climbs one advertised version at a time', () => {
		expect(pushableSchemaVersion(null)).toBe(3);
		expect(pushableSchemaVersion(['zero_loss_v4'])).toBe(4);
		expect(pushableSchemaVersion(['zero_loss_v4', 'analysis_v5'])).toBe(5);
		expect(pushableSchemaVersion(['zero_loss_v4', 'analysis_v5', 'feed_lenses_v6'])).toBe(6);
		// v6 named without v5 is not a server to trust with v6.
		expect(pushableSchemaVersion(['zero_loss_v4', 'feed_lenses_v6'])).toBe(4);
	});
});
