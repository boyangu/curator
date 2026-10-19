// Shared display formatters (F3.0 — extracted from main.ts so feature
// modules import instead of reaching into the orchestrator). Pure
// functions only; no DOM, no state.

export const fmt2 = (n: number): string => String(n).padStart(2, '0');

export const fmtTime = (sec: number | null): string => {
	if (!sec) return '—';
	return `${fmt2(Math.floor(sec / 60))}:${fmt2(sec % 60)}`;
};

// Terse age for table columns: <1d / 3d / 2w / 5mo / 1y.
export const fmtAgo = (d: Date | string | null): string => {
	if (!d) return '—';
	const ms = Date.now() - new Date(d).getTime();
	const days = Math.floor(ms / 86400000);
	if (days < 1) return '<1d';
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
};

// More expressive relative format for the Sync view dates — covers seconds /
// minutes / hours / days / months / years with a single word + number.
export const fmtRelative = (d: Date | string | null): string => {
	if (!d) return '—';
	const ms = Date.now() - new Date(d).getTime();
	if (ms < 0) return 'just now';
	const s = Math.floor(ms / 1000);
	if (s < 60) return s < 5 ? 'just now' : `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const days = Math.floor(h / 24);
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
};

// Deterministic per-index cover-art fallback gradient.
export const coverGradient = (i: number): string => {
	const hues = [25, 65, 105, 145, 195, 230, 280, 320];
	const h1 = hues[i % hues.length];
	const h2 = hues[(i * 3 + 2) % hues.length];
	return `linear-gradient(135deg, oklch(0.45 0.16 ${h1}), oklch(0.18 0.08 ${h2}))`;
};

// 0–999 → "123"; 1,000–9,999 → "1,234"; 10,000+ → "15k"; 1,000,000+ → "1.2M"
export function fmtCount(n: number): string {
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}M`;
	}
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return n.toLocaleString('en-US');
	return String(n);
}

// Human-friendly byte size — KB / MB / GB by magnitude, one decimal.
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Release date for the track list. Stored as ISO "2021-03-15", "2021-03" or
// year-only "2021". A full date in the last 30 days (local calendar) reads
// as an age — "today", "1 day", "12 days" — because a fresh release is what
// a digging DJ scans for; anything older (or with no day) is "Mar, 2021" /
// "2021". The string components are parsed directly: `new Date(iso)` would
// shift a bare date by the timezone and can roll the day back.
export function fmtReleaseLabel(d: string | null | undefined, now: Date = new Date()): string {
	if (!d) return '—';
	const [ys, ms, ds] = d.split('-');
	const y = Number(ys);
	if (!ys || !Number.isFinite(y)) return '—';
	const m = ms ? Number(ms) - 1 : NaN;
	const day = ds ? Number(ds) : NaN;
	if (Number.isFinite(m) && Number.isFinite(day)) {
		const rel = new Date(y, m, day).getTime();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const days = Math.round((today - rel) / 86400000);
		if (days >= 0 && days <= 30) return days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
	}
	return MONTHS[m] ? `${MONTHS[m]}, ${ys}` : ys;
}
