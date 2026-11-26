// A label given as text is the label of that name (the catalogue's rule for
// labels written as text, on the cloud at ingestion and in a library's own
// tags) — except a distribution service's name, which is no label: an artist
// releasing through one has none, and the text stays text.

import { nameFold } from './name-fold.js';

// DistroKid also names imprints "<number> Records DK" (DK2…).
const DISTRIBUTORS = new Set(
	[
		'distrokid',
		'cd baby',
		'cdbaby',
		'tunecore',
		'believe',
		'believe digital',
		'amuse',
		'amuseio ab',
		'ditto music',
		'ditto',
		'routenote',
		'symphonic',
		'symphonic distribution',
		'label worx',
		'labelworx',
		'kudos records',
		'onerpm',
		'awal',
		'united masters',
		'unitedmasters',
		'level',
		'record union',
		'spinnup',
		'soundrop',
		'emubands',
		'self released',
		'self-released',
		'independent',
		'not on label',
	].map((n) => nameFold(n)),
);
const DISTROKID_IMPRINT = /^\d+ records dk\d*$/;

export function isDistributor(name: string): boolean {
	const fold = nameFold(name);
	return !fold || DISTRIBUTORS.has(fold) || DISTROKID_IMPRINT.test(fold);
}
