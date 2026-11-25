// The guard of the loopback servers (cli/local.ts, cloud-worker.ts,
// backoffice.ts). They answer without a sign-in because only this machine
// reaches them, but a web page open in this machine's browser is on this
// machine too. A page elsewhere cannot send `application/json` without a
// preflight, which none of them answers, and one whose own name was pointed at
// 127.0.0.1 still says that name in `Host`.

export function fromThisMachinesPages(req: { method: string; host: string | null | undefined; contentType: string | null | undefined }, port: number): boolean {
	if (req.host !== `127.0.0.1:${port}` && req.host !== `localhost:${port}`) return false;
	return req.method === 'GET' || (req.contentType ?? '').toLowerCase().startsWith('application/json');
}
