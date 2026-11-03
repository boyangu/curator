-- Curator cloud, migration 0023: what the back office learned about an object, in words.
--
-- A catalogue object holds what its providers claim (catalog_fact: one value per field and
-- source, no author). What an operator or the agent concluded while working on it has had nowhere
-- to live but the inbox log, which is about an action, not the object: "the Bandcamp listing is
-- partial (1 of 6 tracks)", "edition: Spotify / Tidal / Bandcamp, 30 tracks" — why two
-- same-titled releases stay apart. Insights are those conclusions, attached to the object, with
-- who wrote them and the evidence they rest on (src/catalog/insights.ts). A merge carries them to
-- the survivor; retiring one keeps the row (the inbox's undo puts it back).
create table curator.catalog_insight (
	id bigint generated always as identity primary key,
	object_id uuid not null references curator.catalog_object (id),
	-- A short tag the views may act on: 'edition' (its body labels the release wherever releases
	-- are listed), 'partial' (a provider's listing short of the release), 'note' (anything else).
	topic text not null check (topic ~ '^[a-z][a-z0-9_-]{0,31}$'),
	body text not null check (length(body) between 1 and 500),
	evidence jsonb not null default '{}'::jsonb,
	-- claude-code | worker | guy
	actor text not null,
	created_at timestamptz not null default now(),
	retired_at timestamptz,
	retired_by text
);
create index catalog_insight_object on curator.catalog_insight (object_id) where retired_at is null;
