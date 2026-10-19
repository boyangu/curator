// Conflict-resolution list for DJ-app sync — provider-neutral by design:
// consumes the SyncConflict wire shape from @curator/shared, so a future
// Traktor/Serato flow reuses it unchanged (only the provider label the
// host passes in differs).
//
// Layout: conflicts grouped by track; each row names the diverged field
// (or cue) and offers a two-way pick — Curator's live value vs the app's
// value — with the last-synced baseline shown as "was: X" for context.

import { createMemo, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { CueUnit, SyncConflict, SyncConflictChoice } from '@curator/shared';

export interface SyncConflictListProps {
	conflicts: SyncConflict[];
	// Display name of the external app, e.g. "Rekordbox".
	providerLabel: string;
	choices: () => Record<string, SyncConflictChoice>;
	onPick(conflictId: string, choice: SyncConflictChoice): void;
}

const FIELD_LABEL: Record<string, string> = {
	title: 'Title',
	artist: 'Artist',
	album: 'Album',
	genre: 'Genre',
	label: 'Label',
	rating: 'Rating',
	comment: 'Comment',
	colorLabel: 'Color',
};

function fmtPos(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}

// 'hot:3' → "Hot cue D"; 'memory:83250' → "Memory cue @ 1:23".
function conflictRowLabel(c: SyncConflict): string {
	if (c.kind === 'order') return 'Track order';
	if (c.kind === 'field') return FIELD_LABEL[c.fieldKey] ?? c.fieldKey;
	if (c.fieldKey.startsWith('hot:')) {
		const slot = Number(c.fieldKey.slice(4));
		const letter = Number.isFinite(slot) && slot >= 0 && slot < 16
			? String.fromCharCode(65 + slot)
			: String(slot);
		return `Hot cue ${letter}`;
	}
	const ms = Number(c.fieldKey.slice('memory:'.length));
	return Number.isFinite(ms) ? `Memory cue @ ${fmtPos(ms / 1000)}` : 'Memory cue';
}

function fmtCue(v: CueUnit | null): string {
	if (v == null) return '(deleted)';
	const parts: string[] = [`@ ${fmtPos(v.positionSec)}`];
	if (v.lengthSec != null && v.lengthSec > 0) parts.push(`loop ${v.lengthSec.toFixed(2)}s`);
	if (v.name) parts.push(`“${v.name}”`);
	if (v.color) parts.push(v.color);
	return parts.join(' · ');
}

function fmtValue(c: SyncConflict, v: unknown): string {
	if (c.kind === 'order') {
		// v is a string[] of rb_content_ids — show a count, not the raw ids.
		const n = Array.isArray(v) ? v.length : 0;
		return `${n} track${n === 1 ? '' : 's'}, this order`;
	}
	if (c.kind === 'cue') return fmtCue((v ?? null) as CueUnit | null);
	if (v == null || v === '') return '(empty)';
	if (c.fieldKey === 'rating') return `${Number(v)}★`;
	return String(v);
}

export function SyncConflictList(props: SyncConflictListProps): JSX.Element {
	const groups = createMemo(() => {
		const byTrack = new Map<string, { title: string; artist: string; items: SyncConflict[] }>();
		for (const c of props.conflicts) {
			const g = byTrack.get(c.trackId);
			if (g) g.items.push(c);
			else byTrack.set(c.trackId, { title: c.trackTitle, artist: c.trackArtist, items: [c] });
		}
		return Array.from(byTrack.values());
	});

	return (
		<div class="sync-conflicts">
			<For each={groups()}>
				{(group) => (
					<div class="sync-conflicts__group">
						<div class="sync-conflicts__track">
							<span class="sync-conflicts__track-title">{group.title}</span>
							<Show when={group.artist}>
								<span class="sync-conflicts__track-artist">{group.artist}</span>
							</Show>
						</div>
						<For each={group.items}>
							{(c) => {
								const picked = (): SyncConflictChoice | undefined => props.choices()[c.id];
								return (
									<div class="sync-conflicts__row">
										<div class="sync-conflicts__field">
											<span class="sync-conflicts__field-name">{conflictRowLabel(c)}</span>
											<span class="sync-conflicts__base" title="Value at last sync">
												was: {fmtValue(c, c.baseValue)}
											</span>
										</div>
										<div class="sync-conflicts__picks">
											<button
												type="button"
												class="sync-conflicts__pick"
												classList={{ 'sync-conflicts__pick--active': picked() === 'ours' }}
												onClick={() => props.onPick(c.id, 'ours')}
											>
												<span class="sync-conflicts__pick-source">Curator</span>
												<span class="sync-conflicts__pick-value">{fmtValue(c, c.oursValue)}</span>
											</button>
											<button
												type="button"
												class="sync-conflicts__pick"
												classList={{ 'sync-conflicts__pick--active': picked() === 'theirs' }}
												onClick={() => props.onPick(c.id, 'theirs')}
											>
												<span class="sync-conflicts__pick-source">{props.providerLabel}</span>
												<span class="sync-conflicts__pick-value">{fmtValue(c, c.theirsValue)}</span>
											</button>
										</div>
									</div>
								);
							}}
						</For>
					</div>
				)}
			</For>
		</div>
	);
}
