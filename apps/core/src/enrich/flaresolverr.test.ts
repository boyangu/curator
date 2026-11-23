import { describe, it, expect } from 'vitest';
import { cloudflareChallengeReason, ProviderUnavailableError } from '@curator/matcher';
import { flareSolverrFetch, type FetchLike } from './flaresolverr.js';

const PAGE = '<html><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></html>';

// A FlareSolverr double: records the /v1 commands, answers from `reply`.
function service(reply: (cmd: Record<string, unknown>) => unknown) {
	const cmds: Record<string, unknown>[] = [];
	const apiFetch: FetchLike = async (_url, init) => {
		const cmd = JSON.parse(String(init?.body)) as Record<string, unknown>;
		cmds.push(cmd);
		return new Response(JSON.stringify(reply(cmd)));
	};
	return { cmds, apiFetch };
}

const direct: string[] = [];
const fallback: FetchLike = async (url) => { direct.push(url); return new Response('direct'); };

describe('flareSolverrFetch', () => {
	it('loads a Beatport page in the browser session and hands back its HTML', async () => {
		const svc = service((c) => (c.cmd === 'sessions.create' ? { status: 'ok' } : { status: 'ok', solution: { url: c.url, status: 200, response: PAGE } }));
		const f = flareSolverrFetch({ baseUrl: 'http://localhost:8191/', fallback, apiFetch: svc.apiFetch });
		const res = await f('https://www.beatport.com/search/tracks?q=x');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(PAGE);
		await f('https://www.beatport.com/track/a/1');
		// One session, reused.
		expect(svc.cmds.map((c) => c.cmd)).toEqual(['sessions.create', 'request.get', 'request.get']);
		expect(svc.cmds[1]).toMatchObject({ session: 'curator-beatport', url: 'https://www.beatport.com/search/tracks?q=x' });
	});

	it('waits for a start under way before asking the service', async () => {
		const svc = service((c) => (c.cmd === 'sessions.create' ? { status: 'ok' } : { status: 'ok', solution: { url: c.url, status: 200, response: PAGE } }));
		let up!: () => void;
		const started = new Promise<void>((res) => { up = res; });
		const f = flareSolverrFetch({ baseUrl: 'http://x', fallback, apiFetch: svc.apiFetch, ready: () => started });
		const pending = f('https://www.beatport.com/track/a/1');
		await new Promise((r) => setTimeout(r, 10));
		expect(svc.cmds).toEqual([]);
		up();
		expect((await pending).status).toBe(200);
		expect(svc.cmds.map((c) => c.cmd)).toEqual(['sessions.create', 'request.get']);
	});

	it('leaves other hosts to the direct fetch', async () => {
		const svc = service(() => { throw new Error('should not be called'); });
		const f = flareSolverrFetch({ baseUrl: 'http://x', fallback, apiFetch: svc.apiFetch });
		expect(await (await f('https://www.traxsource.com/search?term=x')).text()).toBe('direct');
		expect(svc.cmds).toEqual([]);
	});

	it('an unsolved challenge reads as a Cloudflare block, so the client backs off', async () => {
		const svc = service((c) => (c.cmd === 'sessions.create' ? { status: 'ok' } : { status: 'error', message: 'Error solving the challenge. Timeout after 60.0 seconds.' }));
		const res = await flareSolverrFetch({ baseUrl: 'http://x', fallback, apiFetch: svc.apiFetch })('https://www.beatport.com/search/tracks?q=x');
		expect(res.status).toBe(403);
		expect(cloudflareChallengeReason(res.status, res.headers, null)).toBe('cf-mitigated:challenge');
	});

	it('a page still on the interstitial is flagged too', async () => {
		const svc = service((c) => (c.cmd === 'sessions.create' ? { status: 'ok' } : { status: 'ok', solution: { url: c.url, status: 200, response: '<title>Just a moment...</title>' } }));
		const res = await flareSolverrFetch({ baseUrl: 'http://x', fallback, apiFetch: svc.apiFetch })('https://www.beatport.com/x');
		expect(cloudflareChallengeReason(res.status, res.headers, null)).toBe('cf-mitigated:challenge');
	});

	it('service down → ProviderUnavailableError saying why, never a direct fetch that reads as a block', async () => {
		const down: FetchLike = async () => {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8191' } });
		};
		let kicked = 0;
		const before = direct.length;
		const f = flareSolverrFetch({ baseUrl: 'http://localhost:8191', fallback, apiFetch: down, describe: () => 'Docker in WSL is not running', onDown: () => kicked++ });
		const err = await f('https://www.beatport.com/x').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProviderUnavailableError);
		expect((err as Error).message).toBe('beatport unavailable — FlareSolverr at http://localhost:8191: connection refused (connect ECONNREFUSED 127.0.0.1:8191) — nothing is listening; Docker in WSL is not running');
		expect(kicked).toBe(1);
		expect(direct.length).toBe(before);
	});

	it('a timeout says so', async () => {
		const slow: FetchLike = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
		const err = await flareSolverrFetch({ baseUrl: 'http://x', fallback, apiFetch: slow, maxTimeoutMs: 1000 })('https://www.beatport.com/x').catch((e: unknown) => e);
		expect((err as Error).message).toContain('no answer within 16s');
	});

	it('retries without the session when a restarted service forgot it', async () => {
		let first = true;
		const svc = service((c) => {
			if (c.cmd === 'sessions.create') return { status: 'ok' };
			if (c.session && first) { first = false; return { status: 'error', message: "This session doesn't exist." }; }
			return { status: 'ok', solution: { url: c.url, status: 200, response: PAGE } };
		});
		const res = await flareSolverrFetch({ baseUrl: 'http://x', fallback, apiFetch: svc.apiFetch })('https://www.beatport.com/x');
		expect(await res.text()).toBe(PAGE);
		expect(svc.cmds.at(-1)!.session).toBeUndefined();
	});
});
