import { describe, expect, it } from 'vitest';
import { CloudTransportError } from './client.js';
import { createStorageDownload, StorageGoneError } from './supabase-storage.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function rig(answers: Array<{ status: number; body: string } | 'offline'>) {
	const sent: Array<{ url: string; headers: Record<string, string> }> = [];
	const tokens = ['t1', 't2'];
	const download = createStorageDownload({
		supabaseUrl: 'https://p.supabase.co',
		publishableKey: 'pk',
		utf8: (b) => new TextDecoder().decode(b),
		accessToken: async (o) => (o?.refresh ? tokens[1]! : tokens[0]!),
		get: async (url, headers) => {
			sent.push({ url, headers });
			const a = answers.shift()!;
			if (a === 'offline') throw new Error('unreachable');
			return { status: a.status, bytes: bytes(a.body) };
		},
	});
	return { download, sent };
}

describe('Storage reads', () => {
	it('asks for the object in its bucket as the user', async () => {
		const { download, sent } = rig([{ status: 200, body: 'part' }]);
		expect(await download('snapshots', 'u1/snap/ab.cgz')).toEqual(bytes('part'));
		expect(sent).toEqual([{ url: 'https://p.supabase.co/storage/v1/object/authenticated/snapshots/u1/snap/ab.cgz', headers: { apikey: 'pk', authorization: 'Bearer t1' } }]);
	});

	it('knows a missing object by status, or by a 400 that says so', async () => {
		for (const a of [{ status: 404, body: '{}' }, { status: 400, body: '{"statusCode":"404","error":"not_found","message":"Object not found"}' }, { status: 400, body: '{"code":"NoSuchKey"}' }]) {
			await expect(rig([a]).download('catalogue', 'u1/peaks/ab.cpk')).rejects.toBeInstanceOf(StorageGoneError);
		}
	});

	it('tries a refused token once more with a fresh one, and says auth when that is refused too', async () => {
		const stale = { status: 400, body: '{"statusCode":"403","error":"Unauthorized","message":"jwt expired"}' };
		const again = rig([stale, { status: 200, body: 'ok' }]);
		expect(await again.download('snapshots', 'x')).toEqual(bytes('ok'));
		expect(again.sent.map((r) => r.headers['authorization'])).toEqual(['Bearer t1', 'Bearer t2']);
		await expect(rig([stale, stale]).download('snapshots', 'x')).rejects.toMatchObject({ kind: 'auth' });
	});

	it('leaves what may pass for later', async () => {
		for (const a of ['offline' as const, { status: 503, body: '' }, { status: 429, body: '' }]) {
			const err = await rig([a]).download('snapshots', 'x').catch((e: unknown) => e);
			expect(err).toBeInstanceOf(CloudTransportError);
			expect((err as CloudTransportError).kind).toBe('network');
		}
	});
});
