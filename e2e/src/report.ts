// report.json + report.html in the work dir, and the console summary.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiffRow } from './compare.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info' | 'skipped';

export type Check = {
	name: string;
	title: string;
	status: CheckStatus;
	summary: string;
	details?: unknown;
	rows?: DiffRow[];
};

export type Report = {
	startedAt: string;
	finishedAt: string;
	// No failed check and no crash.
	ok: boolean;
	// 0 ok; 1 a Curator-owned difference (a failed check); 2 the run itself
	// stopped (a refusal, a timeout, an exception) before it could compare.
	exitCode: 0 | 1 | 2;
	error: string | null;
	dryRun: boolean;
	workDir: string;
	sources: { curatorDb: string; rbDb: string };
	timings: Record<string, number>;
	facts: Record<string, unknown>;
	checks: Check[];
	log: { warnings: number; errors: number; samples: Array<{ level: string; area: string; msg: string }> };
};

const esc = (v: unknown): string => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const json = (v: unknown): string => esc(JSON.stringify(v, null, 1) ?? 'null');

function html(r: Report): string {
	const badge = (s: string): string => `<span class="b ${s}">${esc(s)}</span>`;
	const checks = r.checks.map((c) => `
<section>
<h2>${badge(c.status)} ${esc(c.title)} <code>${esc(c.name)}</code></h2>
<p>${esc(c.summary)}</p>
${c.details !== undefined ? `<details><summary>details</summary><pre>${json(c.details)}</pre></details>` : ''}
${c.rows && c.rows.length > 0 ? `<table><thead><tr><th>table / field</th><th>key</th><th>left</th><th>right</th></tr></thead><tbody>${c.rows.map((d) => `<tr><td>${esc(d.table)}</td><td><code>${esc(d.key)}</code></td><td><pre>${json(d.left)}</pre></td><td><pre>${json(d.right)}</pre></td></tr>`).join('')}</tbody></table>` : ''}
</section>`).join('');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>rekordbox e2e report</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e3e3e6; --pass: #1f7a3a; --fail: #b3261e; --warn: #9a6400; --info: #3a5ccc; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececee; --muted: #9a9aa0; --line: #2c2c30; --pass: #5cc27a; --fail: #ff7b72; --warn: #e3b341; --info: #8aa4ff; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 1200px; padding: 16px; }
h1 { font-size: 20px; } h2 { font-size: 15px; margin: 18px 0 6px; }
code, pre { font: 12px ui-monospace, Consolas, monospace; } pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
table { border-collapse: collapse; width: 100%; } td, th { border-top: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
section { border-top: 1px solid var(--line); } .muted { color: var(--muted); }
.b { display: inline-block; min-width: 54px; text-align: center; border-radius: 4px; padding: 0 6px; color: var(--bg); font-weight: 600; font-size: 12px; }
.pass { background: var(--pass); } .fail { background: var(--fail); } .warn { background: var(--warn); } .info, .skipped { background: var(--info); }
</style></head><body>
<h1>${badge(r.ok ? 'pass' : 'fail')} rekordbox end-to-end${r.dryRun ? ' (dry run)' : ''}</h1>
<p class="muted">${esc(r.startedAt)} → ${esc(r.finishedAt)} · work dir <code>${esc(r.workDir)}</code> · exit ${r.exitCode}</p>
${r.error ? `<p><strong>Stopped:</strong> <code>${esc(r.error)}</code></p>` : ''}
<p class="muted">sources: <code>${esc(r.sources.curatorDb)}</code>, <code>${esc(r.sources.rbDb)}</code> (read only)</p>
${checks}
<section><h2>Timings (ms)</h2><pre>${json(r.timings)}</pre></section>
<section><h2>Facts</h2><pre>${json(r.facts)}</pre></section>
<section><h2>Log</h2><p>${r.log.warnings} warnings, ${r.log.errors} errors (core.jsonl in the work dir)</p><pre>${json(r.log.samples)}</pre></section>
</body></html>
`;
}

export function writeReport(dir: string, r: Report): void {
	writeFileSync(join(dir, 'report.json'), JSON.stringify(r, null, 2), 'utf8');
	writeFileSync(join(dir, 'report.html'), html(r), 'utf8');
}

export function summaryLines(r: Report): string[] {
	const out = [`rekordbox e2e${r.dryRun ? ' (dry run)' : ''}: ${r.ok ? 'PASS' : 'FAIL'} (exit ${r.exitCode})`];
	if (r.error) out.push(`  stopped: ${r.error}`);
	for (const c of r.checks) out.push(`  [${c.status.padEnd(7)}] ${c.title}: ${c.summary}`);
	out.push(`  report: ${join(r.workDir, 'report.html')}`);
	return out;
}
