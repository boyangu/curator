import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackUrl, shareSpotifyLogin } from './local-catalog-login.js';

afterEach(() => {
	vi.useRealTimers();
});

const recorder = () => {
	const sent: { url: string; body: unknown; type: string | null }[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		sent.push({ url, body: JSON.parse(String(init.body)), type: new Headers(init.headers).get('content-type') });
		return new Response('{}');
	}) as unknown as typeof fetch;
	return { sent, fetchFn };
};

describe('shareSpotifyLogin', () => {
	it('sends the current token at once and every minute, as JSON', async () => {
		vi.useFakeTimers();
		const { sent, fetchFn } = recorder();
		const tokens = ['first', 'second'];
		const stop = shareSpotifyLogin('http://127.0.0.1:8787', async () => tokens.shift() ?? null, fetchFn);

		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toEqual([{ url: 'http://127.0.0.1:8787/local/spotify-user-token', body: { accessToken: 'first' }, type: 'application/json' }]);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(sent[1]!.body).toEqual({ accessToken: 'second' });

		// Disconnected: the server is told, so it stops reading with the old one.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sent[2]!.body).toEqual({ accessToken: null });

		stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent).toHaveLength(3);
	});

	it('never sends a token off this machine', async () => {
		const { sent, fetchFn } = recorder();
		const token = vi.fn(async () => 'secret');
		shareSpotifyLogin('https://catalog.example.com', token, fetchFn);
		await Promise.resolve();
		expect(sent).toEqual([]);
		expect(token).not.toHaveBeenCalled();
		expect(isLoopbackUrl('http://localhost:8787')).toBe(true);
		expect(isLoopbackUrl('http://127.0.0.1.example.com')).toBe(false);
		expect(isLoopbackUrl('not a url')).toBe(false);
	});

	it('shrugs off a server that is not running', async () => {
		const fetchFn = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
		const stop = shareSpotifyLogin('http://127.0.0.1:8787', async () => 'token', fetchFn);
		await Promise.resolve();
		stop();
	});
});
