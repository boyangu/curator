// QuickJS-ng 0.18.0: a Map (or Set) with more than a few entries does not
// find a long string key that was built by concatenation when it is looked
// up with an equal string held flat — and, depending on how each was built,
// with an equal concatenated one. A concatenation past 512 characters is kept
// as a rope, and map_hash_key hashes a rope leaf by leaf, mixing in each
// leaf's own length and the rope's tag: not the hash of the same characters
// as one string.
//
// Found by the spike's row-for-row comparison: 30 fingerprint claims (keys of
// 2-4 thousand characters) were written and then deleted by the store's
// flush, because `map.has(key)` said no for a key the map held.
//
//   host map-rope-repro.js      QuickJS prints "by flat copy 0 of 2000"; Node prints 2000
//
// Plain JavaScript, nothing of the host but print.

const print = (s) => (typeof __host !== 'undefined' ? __host.print(s) : console.log(s));

const value = 'A'.repeat(3000);
const map = new Map();
const set = new Set();
const keys = [];
for (let i = 0; i < 2000; i++) {
	const key = `${i}:fingerprint:${value}`;
	map.set(key, i);
	set.add(key);
	keys.push(`${i}:fingerprint:${value}`);
}
const flat = (s) => JSON.parse(JSON.stringify(s));
print(`map of ${map.size} long keys: found by a key built the same way ${keys.filter((k) => map.has(k)).length}, by flat copy ${keys.filter((k) => map.has(flat(k))).length} of ${keys.length}`);
print(`set of ${set.size} long keys: found by flat copy ${keys.filter((k) => set.has(flat(k))).length} of ${keys.length}`);
print(`the strings are equal: ${keys.every((k) => k === flat(k))}`);
