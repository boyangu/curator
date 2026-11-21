-- Curator cloud, migration 0033: is there an artist of exactly this name elsewhere?
--
-- An artist named like several ("Sandy & Junior", "Paul Lomax, Tom Pool") is one act or a
-- credit kept whole, and the catalogue's own pages often cannot say which: 3,961 of 7,821 such
-- names on 2026-11-19 had no store evidence either way, many only because the catalogue never
-- read Spotify for them. The compound detector (src/catalog/compound-artists.ts) asks outside
-- for the whole name — MusicBrainz, then Spotify on its paced budget — and this is what each
-- answered.
--
-- Keyed by the folded name and the source: an answer stands for every object of that name, and
-- a name is asked once. A row with `found` null is an answer too (asked: no artist of that
-- name); a failed or refused call writes no row.
create table curator.catalog_name_lookup (
	name_fold text not null,
	source text not null check (source in ('musicbrainz', 'spotify')),
	-- The source's artist of that exact name: { id, name, type?, followers? }.
	found jsonb,
	asked_at timestamptz not null default now(),
	primary key (name_fold, source)
);
