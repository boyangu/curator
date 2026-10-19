// Shim logging. stdout is the MCP transport — NOTHING but protocol may ever
// be written there, so logs go to stderr (Claude Desktop captures stderr into
// its per-server MCP logs) and optionally to CURATOR_MCP_LOG_FILE.

import { appendFileSync } from 'node:fs';

const logFile = process.env['CURATOR_MCP_LOG_FILE'];

export function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
	const line = JSON.stringify({ at: new Date().toISOString(), level, msg, ...(extra ?? {}) });
	process.stderr.write(line + '\n');
	if (logFile) {
		try { appendFileSync(logFile, line + '\n'); } catch { /* file sink is best-effort */ }
	}
}
