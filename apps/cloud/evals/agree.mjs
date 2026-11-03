// Grades one replayed case: per decided pair, does the reasoner's verdict
// match the operator's? "unsure" earns half (it routes the pair to a human,
// which is safe but not an answer). A case passes when every decided pair
// agrees; the gate (summary.mjs) is pair agreement over the whole set.

export function score(output, vars) {
	let verdict;
	try {
		verdict = typeof output === 'string' ? JSON.parse(output) : output;
	} catch {
		return { agree: 0, pairs: 0, rows: [] };
	}
	// The pack and the labels arrive as JSON strings (see the export).
	const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
	const asked = json(vars.pack)?.evidence?.pairs ?? [];
	const answered = Array.isArray(verdict?.pairs) ? verdict.pairs : [];
	const rows = [];
	for (const [i, expected] of (json(vars.expected) ?? []).entries()) {
		if (expected !== 'same' && expected !== 'different') continue;
		const keep = asked[i]?.keep?.id;
		const fold = asked[i]?.fold?.id;
		// By ids when the pack carried them; by position otherwise.
		const got = (keep && fold ? answered.find((p) => p.keep === keep && p.fold === fold) : undefined) ?? answered[i];
		const said = got?.verdict ?? 'missing';
		rows.push({ i, expected, said, credit: said === expected ? 1 : said === 'unsure' ? 0.5 : 0 });
	}
	return { agree: rows.reduce((s, r) => s + r.credit, 0), pairs: rows.length, rows };
}

export default function (output, context) {
	const s = score(output, context.vars);
	const ratio = s.pairs ? s.agree / s.pairs : 0;
	const wrong = s.rows.filter((r) => r.credit < 1).map((r) => `pair ${r.i}: said ${r.said}, Guy ${r.expected}`);
	return {
		pass: s.pairs > 0 && s.agree === s.pairs,
		score: ratio,
		reason: wrong.length ? wrong.join('; ') : `${s.pairs} pair(s) agree`,
		namedScores: { pairsAgreed: s.agree, pairsDecided: s.pairs },
	};
}
