-- Curator cloud, migration 0025: a case keeps the evidence it was decided on.
--
-- A merge moves the loser's sources, identifiers and edges onto the keeper, and the readers follow
-- merged_into, so once a pair is merged nothing in the catalogue shows the pair as the reasoner saw
-- it. The regression set (apps/cloud/evals) replays decided cases against a changed prompt pack;
-- it needs the pack itself. Written when a case is decided, never on a dry run.
alter table curator.catalog_agent_case add column pack jsonb;
