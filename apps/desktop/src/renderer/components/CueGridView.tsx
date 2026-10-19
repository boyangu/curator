// CueGridView — the 8×2 cue-pad grid shown in big-mode beside the
// transport. Pure presentational + click-dispatch; the host supplies the
// cue list (reactive Accessor) and the action callback. Component owns
// its own page state (1-8 / 9-16 toggle).
//
// Architecturally single-instance per playback context today, but the
// props are deck-shaped: a future preview deck could mount its own
// CueGridView against a different track's cues + a no-op onCueJump
// (visual-only) or a per-deck seek action.

import { For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import type { CueData } from '../stores/analysisStore.js';
import { cueColor } from '../cuePalette.js';

const SLOTS_PER_PAGE = 8;

export interface CueGridViewProps {
	cues: Accessor<CueData[]>;
	// Triggered when a cue pad is clicked. lengthSec is null for point cues
	// and > 0 for loop cues — the deck uses it to activate a loop region.
	// cueId is forwarded so the deck can detect "click the same loop-cue
	// twice → exit loop" without state in this component.
	onCueJump: (positionSec: number, lengthSec: number | null, cueId: string) => void;
	// Pending trigger position from the deck — set between a quantize-
	// deferred click and its fire. Component flashes the matching cue
	// button so the user sees the click landed even though the seek is
	// still waiting for the next beat. Matched by positionSec equality
	// (cues have unique positions in practice; ties just flash both).
	pendingTrigger?: Accessor<number | null>;
	// Click on an empty pad — host decides whether to store a point cue
	// at the current playhead or a loop cue from the active loop region.
	// Component just forwards the slot index it owns.
	onCreateCue?: (slot: number) => void;
	// Right-click on a set pad — host opens its context menu (rename /
	// recolor / delete). Component supplies the cue so the host doesn't
	// need to re-look it up by slot.
	onCueContextMenu?: (evt: MouseEvent, cue: CueData) => void;
}

export function CueGridView(props: CueGridViewProps) {
	const [page, setPage] = createSignal<0 | 1>(0);

	// Render exactly SLOTS_PER_PAGE buttons. Lookup is by hot-cue slot,
	// NOT by array position — a track with hot cues at rekordbox slots
	// A,B,C,H must show D-G empty, which only works if slot 7 maps to the
	// H pad regardless of how many earlier slots are filled. Memory cues
	// (kind === 'memory', slot >= 100) are filtered out; rekordbox shows
	// them on the waveform, not in the hot-cue pad grid.
	const slots = () => {
		const bySlot = new Map<number, CueData>();
		for (const c of props.cues()) {
			if (c.kind === 'hot') bySlot.set(c.slot, c);
		}
		const start = page() * SLOTS_PER_PAGE;
		const out: Array<{ idx: number; letter: string; cue: CueData | undefined }> = [];
		for (let i = 0; i < SLOTS_PER_PAGE; i++) {
			const cueIdx = start + i;
			const letter = cueIdx < 26 ? String.fromCharCode(65 + cueIdx) : String(cueIdx + 1);
			out.push({ idx: cueIdx, letter, cue: bySlot.get(cueIdx) });
		}
		return out;
	};

	return (
		<div class="cues sunken big-only">
			<div class="cue-grid">
				<For each={slots()}>
					{(slot) => (
						<Show
							when={slot.cue}
							fallback={
								<button
									class="cue-slot is-empty"
									title={`${slot.letter} · empty — click to set`}
									onClick={() => props.onCreateCue?.(slot.idx)}
								>
									{slot.letter}
								</button>
							}
						>
							{(cue) => {
								const c = cue();
								const mins = Math.floor(c.positionSec / 60);
								const secs = String(Math.floor(c.positionSec) % 60).padStart(2, '0');
								const isLoop = c.lengthSec != null && c.lengthSec > 0;
								// Read pendingTrigger inside the button render so the
								// is-pending class re-evaluates reactively without
								// the parent <For> needing to know about it.
								const isPending = () => props.pendingTrigger?.() === c.positionSec;
								return (
									<button
										class="cue-slot is-set"
										classList={{ 'is-pending': isPending(), 'is-loop': isLoop }}
										style={{ background: cueColor(c.color) }}
										title={`${c.name ?? c.kind} · ${mins}:${secs}`}
										onClick={() => props.onCueJump(c.positionSec, c.lengthSec, c.id)}
										onContextMenu={(evt) => {
											if (!props.onCueContextMenu) return;
											evt.preventDefault();
											props.onCueContextMenu(evt, c);
										}}
									>
										<span class="cue-letter">
											{slot.letter}
											<Show when={isLoop}>
												{/* lucide `repeat` — shown next to the letter for
												    loop cues so the user can tell point/loop cues
												    apart at a glance. */}
												<svg class="cue-loop-icon" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<path d="m17 2 4 4-4 4" />
													<path d="M3 11v-1a4 4 0 0 1 4-4h14" />
													<path d="m7 22-4-4 4-4" />
													<path d="M21 13v1a4 4 0 0 1-4 4H3" />
												</svg>
											</Show>
										</span>
										<span class="cue-time">{mins}:{secs}</span>
									</button>
								);
							}}
						</Show>
					)}
				</For>
			</div>
			<div class="cue-pages">
				<button
					class="cue-page"
					classList={{ 'is-active': page() === 0 }}
					title="Cues 1-8"
					onClick={() => setPage(0)}
				>1</button>
				<button
					class="cue-page"
					classList={{ 'is-active': page() === 1 }}
					title="Cues 9-16"
					onClick={() => setPage(1)}
				>2</button>
			</div>
		</div>
	);
}

export interface CueGridViewHandle {
	destroy(): void;
}

export function mountCueGridView(host: HTMLElement, props: CueGridViewProps): CueGridViewHandle {
	const dispose = render(() => <CueGridView {...props} />, host);
	return { destroy: dispose };
}
