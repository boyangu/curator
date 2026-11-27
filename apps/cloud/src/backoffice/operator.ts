// Who wrote an operator setting from the back office: this machine and its
// user, stamped by the host process (cli/backoffice.ts, cli/local.ts) on the
// ops that record it. Whatever the page sent as `by` is overwritten — the
// page is not who; the machine holding the credential is.

import { hostname, userInfo } from 'node:os';

const STAMPED: ReadonlySet<string> = new Set(['configSet', 'configReset']);

export const operatorMachine = (): string => `${hostname()}/${userInfo().username}`;

export function stamped(op: string, args: unknown): unknown {
	if (!STAMPED.has(op)) return args;
	return { ...(args && typeof args === 'object' ? args : {}), by: operatorMachine() };
}
