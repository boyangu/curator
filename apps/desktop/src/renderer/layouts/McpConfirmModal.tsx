// McpConfirmModal — approval gate for Claude-initiated writes arriving over
// the MCP bridge. Main broadcasts 'mcp:confirm' (with a hard timeout on its
// side — no answer ⇒ deny), this modal shows what exactly is about to happen
// (op summary + track lines) and answers via 'mcp:confirm-response'.
//
// Deliberate keyboard shape: Esc denies, Enter does NOTHING — an approval of
// a live-account mutation must be a pointed click, never a stray keystroke
// landing on a dialog the user hasn't read (the ~100-playlist incident is
// why this modal exists at all).
//
// Concurrent requests queue: Claude can fire parallel write calls, each with
// its own requestId; we show them one at a time in arrival order.

import { createSignal, For, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { registerModalOpenSignal } from '../modalGate.js';
import type { McpConfirmEvent } from '../../ipc.js';

export interface McpConfirmModalHandle {
	destroy(): void;
	push(evt: McpConfirmEvent): void;
}

export function mountMcpConfirmModal(
	host: HTMLElement,
	deps: { respond: (requestId: string, approved: boolean, alwaysAllow?: boolean) => void },
): McpConfirmModalHandle {
	const [current, setCurrent] = createSignal<McpConfirmEvent | null>(null);
	const [secondsLeft, setSecondsLeft] = createSignal(0);
	const isOpen = () => current() != null;
	registerModalOpenSignal(isOpen);
	const queue: McpConfirmEvent[] = [];
	let countdownTimer: ReturnType<typeof setInterval> | null = null;

	const show = (evt: McpConfirmEvent): void => {
		setCurrent(evt);
		// Renderer countdown mirrors main's deadline (minus a grace second so
		// we never show "0s" on a still-pending request).
		const deadline = Date.now() + evt.timeoutMs - 1_000;
		setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
		countdownTimer = setInterval(() => {
			const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
			setSecondsLeft(left);
			// Main has already denied at this point — just get out of the way.
			if (left <= 0) resolve(false);
		}, 1000);
	};

	const resolve = (approved: boolean, alwaysAllow?: boolean): void => {
		const evt = current();
		if (!evt) return;
		if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
		setCurrent(null);
		deps.respond(evt.requestId, approved, alwaysAllow);
		const next = queue.shift();
		if (next) show(next);
	};

	const push = (evt: McpConfirmEvent): void => {
		if (isOpen()) queue.push(evt);
		else show(evt);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); resolve(false); }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const dispose = render(() => (
		<Show when={current()}>
			{(evt) => (
				<div class="modal-overlay">
					<div class="modal mcp-confirm" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
						<header class="modal__head">
							<h3 id="mcp-confirm-title">Claude wants to modify your library</h3>
						</header>
						<div class="modal__body mcp-confirm__body">
							<p class="mcp-confirm__op">{evt().title}</p>
							<Show when={evt().kind === 'streaming-playlist-write'}>
								<p class="mcp-confirm__warning">This changes your live streaming account.</p>
							</Show>
							<Show when={evt().detailLines.length > 0}>
								<ul class="mcp-confirm__tracks">
									<For each={evt().detailLines}>{(line) => <li>{line}</li>}</For>
								</ul>
							</Show>
							<p class="mcp-confirm__timeout">Denies automatically in {secondsLeft()}s</p>
						</div>
						<footer class="modal__foot mcp-confirm__foot">
							{/* "Always approve" waives this KIND of write (streaming vs
							    destructive — not both) until the app restarts; every
							    auto-approval still toasts. Deliberately the least
							    prominent button. */}
							<button
								class="btn-secondary mcp-confirm__always"
								type="button"
								title={evt().kind === 'destructive-write'
									? 'Approve, and stop asking for track removals until Curator restarts'
									: 'Approve, and stop asking for streaming playlist writes until Curator restarts'}
								onClick={(e) => { e.preventDefault(); resolve(true, true); }}
							>Always approve</button>
							<span class="mcp-confirm__spacer" />
							<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); resolve(false); }}>Deny</button>
							<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); resolve(true); }}>Approve</button>
						</footer>
					</div>
				</div>
			)}
		</Show>
	), host);

	return {
		destroy: () => {
			if (countdownTimer) clearInterval(countdownTimer);
			document.removeEventListener('keydown', onKeyDown, true);
			dispose();
		},
		push,
	};
}
