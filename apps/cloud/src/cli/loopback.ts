// The guard of the loopback servers (cli/local.ts, cloud-worker.ts,
// backoffice.ts). They answer without a sign-in because only this machine
// reaches them, but a web page open in this machine's browser is on this
// machine too. A page elsewhere cannot send `application/json` without a
// preflight, which none of them answers, and one whose own name was pointed at
// 127.0.0.1 still says that name in `Host`.

import { timingSafeEqual } from 'node:crypto';

export function fromThisMachinesPages(req: { method: string; host: string | null | undefined; contentType: string | null | undefined }, port: number): boolean {
	if (req.host !== `127.0.0.1:${port}` && req.host !== `localhost:${port}`) return false;
	return req.method === 'GET' || (req.contentType ?? '').toLowerCase().startsWith('application/json');
}

// The back office as the desktop app runs it for its operator
// (apps/desktop/src/main/cloud-admin.ts): a secret per launch, handed to this
// process and to the app's own view of it only, carried on every request. A
// page in a browser, or another program on this machine, does not have it —
// so only the app's tab reads or writes production through this process.
// Without a token set (run by hand in a browser) the guard above is the gate.
export function carriesAdminToken(header: string | string[] | undefined, token: string | undefined): boolean {
	if (!token) return true;
	const sent = Array.isArray(header) ? header[0] : header;
	if (typeof sent !== 'string') return false;
	const a = Buffer.from(sent);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}
