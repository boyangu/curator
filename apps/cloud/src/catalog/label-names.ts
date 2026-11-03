// A label's name is a few words that name it and some that only say it is a
// label ("Records", "Music", "Schallplatten"). Look-alike detection compares
// the naming words (label-related.ts); a merge keeps the plainer name.

// Words a label's name carries without naming it.
const FILLER = new Set(['records', 'record', 'recordings', 'recording', 'rec', 'recs', 'music', 'musik', 'label', 'imprint', 'schallplatten', 'ltd', 'limited', 'inc', 'the', 'official', 'ofc', 'digital', 'audio']);

export function labelWords(name: string): string[] {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

// Its naming words: the filler dropped, unless that leaves nothing ("Music Records").
export function labelCore(name: string): string[] {
	const words = labelWords(name);
	const core = words.filter((w) => !FILLER.has(w));
	return core.length ? core : words;
}

// Of two names for one label, the plainer: fewer filler words, then fewer
// words ("Diynamic" over "Diynamic Music", "Traum" over "TRAUM
// Schallplatten"); a tie keeps the first (the merge's winner).
export function plainerLabelName(kept: string, other: string): string {
	const filler = (n: string) => labelWords(n).length - labelCore(n).length;
	const k = [filler(kept), labelWords(kept).length];
	const o = [filler(other), labelWords(other).length];
	return o[0]! < k[0]! || (o[0] === k[0] && o[1]! < k[1]!) ? other : kept;
}
