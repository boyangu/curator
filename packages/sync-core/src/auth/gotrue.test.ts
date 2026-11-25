// The phone's sign-in against a scripted Supabase Auth: what it sends, what
// keeps a session and what ends one.

import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '../sync-log/fetch-transport.js';
import { AuthError, createGotrue, type AuthAccount } from './gotrue.js';

const URL_ = 'https://p.supabase.co';
const USER = { id: 'u1', email: 'guy@example.com' };
const session = (n: number, user = USER): HttpResponse => ({
	status: 200,
	body: JSON.stringify({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, expires_at: 1, token_type: 'bearer', user }),
});
const refused = (status: number, error_code: string): HttpResponse => ({ status, body: JSON.stringify({ code: status, error_code, msg: 'guy@example.com said no' }) });

function rig(answers: Array<HttpResponse | 'offline' | Promise<HttpResponse>>, initial: AuthAccount | null = null, holdsLibrary = true) {
	const sent: HttpRequest[] = [];
	const kept: Array<AuthAccount | null> = [];
	const clock = { now: 1_000_000 };
	const auth = createGotrue({
		supabaseUrl: URL_,
		publishableKey: 'pk',
		initial,
		holdsLibrary: () => holdsLibrary,
		onChange: (a) => kept.push(a),
		now: () => clock.now,
		request: async (req) => {
			sent.push(req);
			const a = answers.shift();
			if (a === undefined) throw new Error('nothing scripted');
			if (a === 'offline') throw new Error('unreachable');
			return a;
		},
	});
	return { auth, sent, kept, clock };
}
const account = (n: number, expiresAt: number): AuthAccount => ({ userId: 'u1', email: USER.email, tokens: { accessToken: `at${n}`, refreshToken: `rt${n}`, expiresAt } });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
	try { await p; } catch (e) { if (e instanceof AuthError) return e.code; throw e; }
	throw new Error('expected it to fail');
};

describe('sign-in', () => {
	it('by password: the request, the account kept, the expiry counted from now', async () => {
		const { auth, sent, kept, clock } = rig([session(1)]);
		const a = await auth.signInPassword(' guy@example.com ', 'pw ');
		expect(sent[0]).toEqual({
			method: 'POST',
			url: `${URL_}/auth/v1/token?grant_type=password`,
			headers: { apikey: 'pk', 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'guy@example.com', password: 'pw ' }),
		});
		expect(a).toEqual(account(1, clock.now + 3_600_000));
		expect(kept).toEqual([a]);
		expect(await auth.accessToken()).toBe('at1');
		expect(sent).toHaveLength(1);
	});

	it('by emailed code, never making an account', async () => {
		const { auth, sent } = rig([{ status: 200, body: '{}' }, session(1)]);
		await auth.requestCode('guy@example.com');
		await auth.verifyCode('guy@example.com', ' 123456 ');
		expect(sent.map((r) => [r.url, JSON.parse(r.body!)])).toEqual([
			[`${URL_}/auth/v1/otp`, { email: 'guy@example.com', create_user: false }],
			[`${URL_}/auth/v1/verify`, { type: 'email', email: 'guy@example.com', token: '123456' }],
		]);
		expect(auth.account()?.userId).toBe('u1');
	});

	it('says why not, by code, in both shapes the server has used', async () => {
		const { auth, kept } = rig([refused(400, 'invalid_credentials'), { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'x' }) }, 'offline', { status: 503, body: '<html>' }, { status: 200, body: '{}' }]);
		expect(await codeOf(auth.signInPassword('a@b.c', 'x'))).toBe('invalid_credentials');
		expect(await codeOf(auth.signInPassword('a@b.c', 'x'))).toBe('invalid_grant');
		expect(await codeOf(auth.signInPassword('a@b.c', 'x'))).toBe('network');
		expect(await codeOf(auth.signInPassword('a@b.c', 'x'))).toBe('server');
		expect(await codeOf(auth.signInPassword('a@b.c', 'x'))).toBe('bad_answer');
		expect(kept).toEqual([]);
	});

	it('refuses another account than the library’s, and ends the session that opened', async () => {
		const over: AuthAccount = { userId: 'u1', email: USER.email, tokens: null };
		const { auth, sent, kept } = rig([session(9, { id: 'u2', email: 'else@example.com' }), { status: 204, body: '' }], over);
		expect(await codeOf(auth.signInPassword('else@example.com', 'x'))).toBe('other_account');
		expect(sent[1]).toMatchObject({ url: `${URL_}/auth/v1/logout?scope=local`, headers: { authorization: 'Bearer at9' } });
		expect(kept).toEqual([]);
		expect(auth.account()).toEqual(over);
	});

	it('takes any account where the last one left no library', async () => {
		const { auth } = rig([session(1, { id: 'u2', email: 'else@example.com' })], { userId: 'u1', email: USER.email, tokens: null }, false);
		expect((await auth.signInPassword('else@example.com', 'x')).userId).toBe('u2');
	});

	it('takes the same person back after their session ended', async () => {
		const { auth } = rig([session(2)], { userId: 'u1', email: USER.email, tokens: null });
		expect(await auth.accessToken()).toBeNull();
		await auth.signInPassword('guy@example.com', 'pw');
		expect(await auth.accessToken()).toBe('at2');
	});
});

describe('a forgotten password', () => {
	it('is replaced once a code signed the account in', async () => {
		const { auth, sent } = rig([session(1), { status: 200, body: JSON.stringify(USER) }]);
		await auth.verifyCode('guy@example.com', '123456');
		await auth.setPassword(' new one ');
		expect(sent[1]).toEqual({
			method: 'PUT',
			url: `${URL_}/auth/v1/user`,
			headers: { apikey: 'pk', 'content-type': 'application/json', authorization: 'Bearer at1' },
			body: JSON.stringify({ password: ' new one ' }),
		});
		expect(await auth.accessToken()).toBe('at1');
	});

	it('says why a new one was refused, and stays signed in', async () => {
		const { auth } = rig([session(1), refused(422, 'weak_password')]);
		await auth.verifyCode('guy@example.com', '123456');
		expect(await codeOf(auth.setPassword('x'))).toBe('weak_password');
		expect(auth.account()?.tokens).not.toBeNull();
	});

	it('needs a session', async () => {
		const { auth, sent } = rig([]);
		expect(await codeOf(auth.setPassword('x'))).toBe('session_not_found');
		expect(sent).toEqual([]);
	});
});

describe('the access token', () => {
	it('is refreshed a minute ahead, once for every caller waiting, and the rotated session kept before they get it', async () => {
		let answer!: (r: HttpResponse) => void;
		const { auth, sent, kept, clock } = rig([new Promise<HttpResponse>((r) => { answer = r; })], account(1, 2_000_000));
		expect(await auth.accessToken()).toBe('at1');
		clock.now = 2_000_000 - 59_000;
		const both = Promise.all([auth.accessToken(), auth.accessToken()]);
		answer(session(2));
		expect(await both).toEqual(['at2', 'at2']);
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0]!.body!)).toEqual({ refresh_token: 'rt1' });
		expect(kept).toEqual([account(2, clock.now + 3_600_000)]);
	});

	it('keeps the one in hand when a refresh cannot be made but it has not expired', async () => {
		const { auth, clock } = rig(['offline', 'offline'], account(1, 2_000_000));
		clock.now = 2_000_000 - 30_000;
		expect(await auth.accessToken()).toBe('at1');
		clock.now = 2_000_001;
		expect(await codeOf(auth.accessToken())).toBe('network');
		expect(auth.account()?.tokens).not.toBeNull();
	});

	it('survives a server’s trouble, a rate limit and a wrong key; ends only on a refusal of the session', async () => {
		for (const r of [{ status: 500, body: 'x' }, refused(429, 'over_request_rate_limit'), { status: 401, body: JSON.stringify({ message: 'Invalid API key' }) }]) {
			const { auth, kept } = rig([r], account(1, 0));
			await codeOf(auth.accessToken());
			expect(kept).toEqual([]);
		}
		for (const code of ['refresh_token_already_used', 'refresh_token_not_found', 'session_not_found', 'user_banned']) {
			const { auth, kept } = rig([refused(400, code)], account(1, 0));
			expect(await auth.accessToken()).toBeNull();
			expect(kept).toEqual([{ userId: 'u1', email: USER.email, tokens: null }]);
		}
	});

	it('is asked for anew when the last one was refused', async () => {
		const { auth } = rig([session(2)], account(1, 9_000_000));
		expect(await auth.accessToken({ refresh: true })).toBe('at2');
	});
});

describe('sign-out', () => {
	it('ends this install’s session only, and forgets the account', async () => {
		const { auth, sent, kept } = rig([{ status: 204, body: '' }], account(1, 9_000_000));
		await auth.signOut();
		expect(sent[0]).toMatchObject({ method: 'POST', url: `${URL_}/auth/v1/logout?scope=local`, headers: { authorization: 'Bearer at1' } });
		expect(kept).toEqual([null]);
		expect(await auth.accessToken()).toBeNull();
	});

	it('can end the session alone: the account stays, for the same person to sign in to', async () => {
		const { auth, kept } = rig([{ status: 204, body: '' }, session(2)], account(1, 9_000_000));
		await auth.endSession();
		expect(kept).toEqual([{ userId: 'u1', email: USER.email, tokens: null }]);
		await auth.signInPassword('guy@example.com', 'pw');
		expect(await auth.accessToken()).toBe('at2');
	});

	it('forgets it offline too', async () => {
		const { auth, kept } = rig(['offline'], account(1, 9_000_000));
		await auth.signOut();
		expect(kept).toEqual([null]);
	});

	it('is not undone by a refresh that was on its way', async () => {
		let answer!: (r: HttpResponse) => void;
		const { auth, kept } = rig([new Promise<HttpResponse>((r) => { answer = r; }), { status: 204, body: '' }], account(1, 0));
		const late = auth.accessToken();
		await auth.signOut();
		answer(session(2));
		await late;
		expect(kept).toEqual([null]);
		expect(auth.account()).toBeNull();
	});
});
