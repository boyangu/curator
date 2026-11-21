-- Curator cloud, migration 0032: Reach, an artist's audience as one open-ended score.
--
-- Each store page's audience (Spotify monthly listeners, Deezer fans, Tidal / SoundCloud
-- followers, YouTube subscribers, Last.fm listeners) is read monthly (src/catalog/audience.ts)
-- and kept as a `catalog_signal` of kind 'audience' — the time series that table was made for —
-- so a score can be set against the one three months before. The score itself is a
-- `catalog_fact` (field 'reach', source 'curator'), rewritten by the scoring pass
-- (src/catalog/reach.ts).
--
-- No new tables: two indexes for the two reads that are new.

-- The scoring pass reads every audience reading of the last months, by kind and age.
create index catalog_signal_kind_at on curator.catalog_signal (kind, observed_at);

-- The scoring pass asks when it last wrote, and drops the scores of artists it no longer scores.
create index catalog_fact_reach on curator.catalog_fact (at) where field = 'reach';
