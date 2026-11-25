// The parts of Supabase the phone signs in with, for the test server
// (serve-cloud.ts): Auth's REST endpoints over tokens the API verifies as it
// does Supabase's, and Storage's authenticated read. Enough to exercise the
// app's whole sign-in on an emulator; what it can't stand in for is Supabase
// itself (its error bodies, its rate limits, real emails, Storage's policies).
//
// Refresh tokens are single-use, as Supabase's are: a reused one ends its
// session. Access tokens are short (--token-ttl), so refreshing happens.

import { randomUUID } from 'node:crypto';

export type FakeUser = { id: string; email: string; password: string };
type Session = { id: string; user: FakeUser; refresh: string };
type Answer = { status: number; body: unknown };

export function createFakeGotrue(opts: { users: FakeUser[]; ttlSec: number; sign(userId: string, o: { exp: string; sessionId: string }): Promise<string>; log(line: string): void }) {
	const sessions = new Map<string, Session>();
	const codes = new Map<string, string>();
	const refused = (status: number, error_code: string): Answer => ({ status, body: { code: status, error_code, msg: error_code } });

	const open = async (user: FakeUser, id: string = randomUUID()): Promise<Answer> => {
		const s: Session = { id, user, refresh: randomUUID() };
		sessions.set(id, s);
		return {
			status: 200,
			body: {
				access_token: await opts.sign(user.id, { exp: `${opts.ttlSec}s`, sessionId: id }),
				refresh_token: s.refresh, expires_in: opts.ttlSec, token_type: 'bearer', user: { id: user.id, email: user.email },
			},
		};
	};
	const byEmail = (email: unknown) => opts.users.find((u) => u.email === String(email).toLowerCase());

	return {
		// `path`: after /auth/v1/, with its query.
		async handle(path: string, body: Record<string, unknown>, bearer: string | null): Promise<Answer> {
			const [route, query = ''] = path.split('?');
			const grant = new URLSearchParams(query).get('grant_type');
			opts.log(`auth ${route}${grant ? ` ${grant}` : ''}`);
			if (route === 'token' && grant === 'password') {
				const user = byEmail(body['email']);
				return user && user.password === body['password'] ? open(user) : refused(400, 'invalid_credentials');
			}
			if (route === 'token' && grant === 'refresh_token') {
				const s = [...sessions.values()].find((x) => x.refresh === body['refresh_token']);
				return s ? open(s.user, s.id) : refused(400, 'refresh_token_not_found');
			}
			if (route === 'otp') {
				const user = byEmail(body['email']);
				if (!user) return refused(422, 'otp_disabled');
				const code = String(Math.floor(100_000 + Math.random() * 900_000));
				codes.set(user.email, code);
				opts.log(`code for ${user.email}: ${code}`);
				return { status: 200, body: {} };
			}
			if (route === 'verify') {
				const user = byEmail(body['email']);
				if (!user || codes.get(user.email) !== body['token']) return refused(403, 'otp_expired');
				codes.delete(user.email);
				return open(user);
			}
			const payload = bearer?.split('.')[1];
			const id = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { session_id?: string }).session_id : undefined;
			if (route === 'user') {
				const s = id ? sessions.get(id) : undefined;
				if (!s) return refused(403, 'session_not_found');
				const next = String(body['password'] ?? '');
				if (next.length < 6) return refused(422, 'weak_password');
				if (next === s.user.password) return refused(422, 'same_password');
				s.user.password = next;
				// As Supabase does: the account's other sessions end.
				for (const x of [...sessions.values()]) if (x.user === s.user && x.id !== s.id) sessions.delete(x.id);
				return { status: 200, body: { id: s.user.id, email: s.user.email } };
			}
			if (route === 'logout') {
				if (id) sessions.delete(id);
				return { status: 204, body: null };
			}
			return refused(404, 'not_found');
		},
		// Every session ended elsewhere ("sign out all other sessions").
		killAll(): number {
			const n = sessions.size;
			sessions.clear();
			return n;
		},
		open: () => [...sessions.values()].map((s) => ({ id: s.id, email: s.user.email })),
		lastCode: (email: string) => codes.get(email) ?? null,
	};
}
