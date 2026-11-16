-- Curator cloud, migration 0029: "Help us connect the dots".
--
-- A user says which store page is an artist's, a label's or an album's on a store the catalogue
-- has not mapped (src/catalog/connect.ts, 'catalog_connect'). Each answer is kept here as that
-- user's vote, whatever came of it: the page attached at once (a trusted account — admin_user —
-- or the page's own releases overlapping the object's, read by the cloud), left with the
-- operator (catalog_inbox, kind connect.link), or refused. A vote is also what keeps the same
-- question from being put to the same user twice.
create table curator.catalog_connect_vote (
	id bigint generated always as identity primary key,
	user_id uuid not null references auth.users (id) on delete cascade,
	device_id text,
	object_id uuid not null references curator.catalog_object (id),
	provider text not null,
	-- The object's kind when asked: artist | label | release.
	kind text not null,
	-- The store's id for the page; '' on a 'none' (no page offered was right).
	provider_id text not null default '',
	url text,
	name text,
	verdict text not null check (verdict in ('is', 'not', 'none')),
	-- cloud (a candidate the catalogue's finders left open) | search (the device's) | pasted
	source text,
	-- What the device read on the page and what the cloud read itself, for the operator.
	evidence jsonb not null default '{}'::jsonb,
	-- attached | waiting | already | conflict | noted
	outcome text not null,
	at timestamptz not null default now(),
	unique (user_id, object_id, provider, provider_id)
);
create index catalog_connect_vote_object on curator.catalog_connect_vote (object_id, provider, provider_id);
