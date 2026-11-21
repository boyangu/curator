-- Curator cloud, migration 0030: is a store's artist page one artist?
--
-- A store can file every artist of one name under a single artist id (Deezer 465319 "Fade",
-- 2026-11-18: 238 albums of rap, J-pop, rock and techno, a dozen people). Attached to one artist
-- as "their Deezer page", it hands them all those releases, and — credited beside each
-- namesake's real page on a shared track — joins the namesakes into one artist. The page
-- validation (src/catalog/artist-validation.ts) reads what the page lists, with the genre the
-- store gives each album, and sets it against what Beatport says the artist is; this is what it
-- found, per page.
--
-- Keyed by the store page, like catalog_source_block: a page that holds several acts does so
-- whichever artist it is attached to. `object_id` is the artist it was read for (the Beatport
-- side of the verdict is theirs). A row is also the mark that the page was read, so it is not
-- read again every pass.
create table curator.catalog_page_check (
	provider text not null,
	kind text not null,
	provider_id text not null,
	object_id uuid not null references curator.catalog_object (id),
	-- mixed: several acts on one page | foreign: one act, not this artist's kind of music
	-- | coherent | thin: too few albums to say
	verdict text not null check (verdict in ('mixed', 'foreign', 'coherent', 'thin')),
	-- What was read and why the verdict: the page's genres, the Beatport anchor, the rule.
	evidence jsonb not null default '{}'::jsonb,
	checked_at timestamptz not null default now(),
	primary key (provider, kind, provider_id)
);
create index catalog_page_check_object on curator.catalog_page_check (object_id);
