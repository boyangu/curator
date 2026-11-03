// The gate over a promptfoo run: agreement with the operator's decisions,
// per class. Guy's pairs are mostly "same", so overall agreement would pass a
// reasoner that never says "different"; the gate holds each class on its own.
// Prints the disagreements (the corrections to read) and the cost. Exit 1
// under the gate, so a pack change cannot slip through a script.

import { readFileSync } from 'node:fs';
import { score } from './agree.mjs';

const GATE = 0.9;
const file = process.argv[2] ?? new URL('./out/results.json', import.meta.url);
const run = JSON.parse(readFileSync(file, 'utf8'));
const results = run.results?.results ?? run.results ?? [];

const by = { same: { agree: 0, pairs: 0 }, different: { agree: 0, pairs: 0 } };
let cost = 0;
let errors = 0;
const misses = [];
for (const r of results) {
	cost += r.response?.cost ?? r.cost ?? 0;
	const vars = r.vars ?? r.testCase?.vars ?? {};
	// promptfoo also puts a failed assertion's reason in `error`: only a
	// provider error, or no answer at all, is an error here.
	const failed = r.response?.error ?? (r.response?.output == null ? (r.error ?? 'no answer') : null);
	if (failed) {
		errors++;
		misses.push(`${vars.id}: error — ${failed}`);
		continue;
	}
	for (const row of score(r.response?.output, vars).rows) {
		by[row.expected].agree += row.credit;
		by[row.expected].pairs++;
		if (row.credit < 1) misses.push(`${vars.id} pair ${row.i}: said ${row.said}, Guy ${row.expected}`);
	}
}

const ratio = (c) => (c.pairs ? c.agree / c.pairs : null);
const show = (c) => (c.pairs ? `${(ratio(c) * 100).toFixed(1)}% of ${c.pairs}` : 'no pairs');
console.log(`${results.length} case(s) · same ${show(by.same)} · different ${show(by.different)} (gate ${GATE * 100}% each) · ${errors} error(s) · $${cost.toFixed(2)}`);
for (const m of misses.slice(0, 40)) console.log(`  ${m}`);
if (misses.length > 40) console.log(`  … ${misses.length - 40} more`);
const pass = errors === 0 && Object.values(by).every((c) => c.pairs === 0 || ratio(c) >= GATE) && by.same.pairs + by.different.pairs > 0;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
