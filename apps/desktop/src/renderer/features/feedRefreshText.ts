// The feed's refresh status in words: one line per source of the pass in
// flight (core FeedRefreshStatus), shared by the Discover progress toast and
// the Discover tab's popover so both always say the same thing.

import type { CatalogWorkerStatus, FeedRefreshResult, FeedRefreshStatus, FeedRefreshStep } from '@curator/core';

type Pass = NonNullable<FeedRefreshStatus['pass']>;

const newCount = (n: number): string => (n > 0 ? `${n} new` : 'nothing new');

export function stepLine(s: FeedRefreshStep): string {
	switch (s.state) {
		case 'pending': return `· ${s.name}`;
		case 'running': return `▸ ${s.name}: ${s.detail ?? 'starting…'}`;
		// A finished step's detail is what it did beyond reading (its note).
		case 'done': return `✓ ${s.name}: ${newCount(s.inserted ?? 0)}${s.detail ? ` · ${s.detail}` : ''}`;
		case 'skipped': return `– ${s.name}: ${s.detail ?? 'skipped'}`;
		case 'error': return `✕ ${s.name}: ${s.error ?? 'failed'}`;
	}
}

// What this desktop's catalogue worker is reading for the user's follows
// right now — a check's drain ("Reading 120 of 1,802 …"), or reads in hand
// on the cadence. Null when it reads nothing.
export function workerLine(w: CatalogWorkerStatus | null): string | null {
	if (!w || w.reason !== 'ok') return null;
	if (w.check && w.check.queued > 0) {
		const n = Math.min(w.check.polled, w.check.queued);
		return `▸ Reading ${n.toLocaleString()} of ${w.check.queued.toLocaleString()} checked follows${w.inHand ? ` (${w.inHand} in hand)` : ''} — new releases land as they are read`;
	}
	if (w.inHand > 0) return `▸ Reading ${w.inHand} of your follows for the catalogue`;
	return null;
}

// What a pass is called while it runs. A background pass is the timer's.
export function passTitle(pass: Pass): string {
	if (!pass.manual) return 'Checking for new releases…';
	return pass.mode === 'backfill' ? 'Loading older items…' : 'Refreshing Discover…';
}

// The steps of the pass in flight, plus what waits behind it. Empty when idle.
export function statusLines(status: FeedRefreshStatus): string[] {
	if (!status.pass) return [];
	const lines = status.pass.steps.map(stepLine);
	if (status.waiting > 0) lines.push(`${status.waiting} more queued behind this one`);
	return lines;
}

// The Discover tab's popover while a pass runs or the worker reads, or null
// when both are idle.
export function statusTooltip(status: FeedRefreshStatus, worker: CatalogWorkerStatus | null = null): string | null {
	const reading = workerLine(worker);
	if (status.pass) return [passTitle(status.pass), ...statusLines(status), ...(reading ? [reading] : [])].join('\n');
	return reading ? ['Reading for the catalogue…', reading].join('\n') : null;
}

// Body of the progress toast for a manual action still waiting on its result.
// The pass in flight may be a background one the action queued behind.
export function progressBody(status: FeedRefreshStatus): string | undefined {
	if (!status.pass) return undefined;
	const lines = statusLines(status);
	return (status.pass.manual ? lines : ['A background check is finishing first:', ...lines]).join('\n') || undefined;
}

// A finished call, per source. Shown under the result when it needs saying:
// several sources ran, or one of them was skipped or failed.
export function resultLines(res: FeedRefreshResult): string[] {
	return res.producers.map((p) =>
		p.error ? `✕ ${p.name}: ${p.error}` : p.skipped ? `– ${p.name}: ${p.skipped}` : `✓ ${p.name}: ${newCount(p.inserted)}${p.note ? ` · ${p.note}` : ''}`,
	);
}

export function resultBody(res: FeedRefreshResult): string | undefined {
	const plain = res.producers.length <= 1 && !res.producers.some((p) => p.error || p.skipped || p.note);
	return plain ? undefined : resultLines(res).join('\n');
}
