-- A task's place between passes: a backfill that reads a label's listing a
-- few releases at a time (trackers/backfill.ts) keeps its adapter cursor here
-- and comes due again until the listing is read through, instead of one poll
-- and done (a Deezer label backfill read four albums and dropped the rest).
alter table curator.catalog_enrich_task add column state jsonb not null default '{}'::jsonb;
