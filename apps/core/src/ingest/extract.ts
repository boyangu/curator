// Hoists fields from music-metadata's IAudioMetadata into a flat ParseResult.
// Used by both parseInline (in-process fallback) and the utility-process
// worker — guarantees the two parse paths never disagree about what a file's
// metadata looks like.

import { basename, extname } from 'node:path';
import type { IAudioMetadata } from 'music-metadata';
import { normalizeIsrc } from '@curator/library-logic';
import type { ParseResult } from './types.js';

export function extract(meta: IAudioMetadata, fallbackPath: string): ParseResult {
	const title = meta.common.title?.trim()
		|| basename(fallbackPath, extname(fallbackPath));

	const artists = meta.common.artists?.length
		? meta.common.artists.filter((a) => a && a.trim()).map((a) => a.trim())
		: meta.common.artist
			? [meta.common.artist.trim()]
			: [];

	const duration = meta.format.duration ? Math.round(meta.format.duration) : null;

	const container = (meta.format.container ?? extname(fallbackPath).slice(1) ?? '')
		.toLowerCase() || null;

	return {
		title: title || null,
		artists,
		albumTitle: meta.common.album ?? null,
		duration,
		// Rippers tag ISRCs however they like (lowercase, hyphenated); only the
		// canonical form may reach the indexed column, and junk becomes null.
		isrc: normalizeIsrc(meta.common.isrc?.[0]),
		bpm: meta.common.bpm ?? null,
		genre: meta.common.genre?.[0] ?? null,
		label: meta.common.label?.[0] ?? null,
		container,
		// Tag-only view: the audio-stream hash is read from the file's bytes by
		// the parser (parseInline), which overlays it on this result.
		audioHash: null,
	};
}
