// Confirm broker for MCP-originated writes. remoteWritePolicy in the desktop
// main is allow-all because the RENDERER confirms before calling write IPC —
// MCP tool calls enter below that confirmation, so this broker restores it:
// broadcast 'mcp:confirm' → renderer modal → 'mcp:confirm-response' resolves
// the pending promise. No answer within the timeout, or no window to ask ⇒
// deny. This is the user-consent gate the CLAUDE.md streaming-writes rule
// requires; without an approval nothing reaches the adapter.

import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { McpConfirmRequest } from '@curator/core';
import { broadcastEvent } from '../events.js';
import { mainLog } from '../log.js';

const clog = mainLog.for('mcp');

export const MCP_CONFIRM_TIMEOUT_MS = 120_000;

export class McpConfirmBroker {
	private pending = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout; kind: McpConfirmRequest['kind'] }>();
	// Kinds the user opted out of confirming ("Always approve" in the modal).
	// Scoped per kind — approving streaming playlist writes does NOT waive the
	// destructive-write modal — and per app run: resets on restart, on purpose.
	// Auto-approvals still toast (visibility) and still hit write-audit.jsonl.
	private alwaysAllowed = new Set<McpConfirmRequest['kind']>();

	confirm(req: McpConfirmRequest): Promise<boolean> {
		if (this.alwaysAllowed.has(req.kind)) {
			clog.info('auto-approved (always allow)', { kind: req.kind, title: req.title });
			this.notify(`Auto-approved: ${req.title}`);
			return Promise.resolve(true);
		}
		const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
		if (windows.length === 0) {
			clog.warn('confirm requested with no window — denying', { title: req.title });
			return Promise.resolve(false);
		}
		// Pull the app in front of Claude Desktop — the user is mid-conversation
		// over there and needs to see what they're being asked to approve.
		const win = windows[0]!;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
		win.flashFrame(true);

		const requestId = randomUUID();
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				clog.warn('confirm timed out — denying', { title: req.title });
				resolve(false);
			}, MCP_CONFIRM_TIMEOUT_MS);
			this.pending.set(requestId, { resolve, timer, kind: req.kind });
			broadcastEvent('mcp:confirm', {
				requestId,
				kind: req.kind,
				title: req.title,
				detailLines: req.detailLines,
				timeoutMs: MCP_CONFIRM_TIMEOUT_MS,
			});
			clog.info('confirm requested', { requestId, kind: req.kind, title: req.title });
		});
	}

	resolve(requestId: string, approved: boolean, alwaysAllow?: boolean): void {
		const p = this.pending.get(requestId);
		if (!p) return; // already timed out — the write was denied
		this.pending.delete(requestId);
		clearTimeout(p.timer);
		// alwaysAllow only ever widens on an APPROVE — a denied request can't
		// establish a standing grant.
		if (approved && alwaysAllow) {
			this.alwaysAllowed.add(p.kind);
			clog.info('always-allow enabled', { kind: p.kind });
		}
		clog.info(approved ? 'confirm approved' : 'confirm denied', { requestId });
		p.resolve(approved);
	}

	notify(message: string): void {
		broadcastEvent('mcp:notify', { message });
	}
}
