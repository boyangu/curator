-- Curator cloud, migration 0011: the Global Catalog ('global_catalog').
--
-- Curator's own model of the music world, shared by every account
-- (packages/protocol/src/catalog-service.ts). Everything enters through one ingestion pipeline
-- (src/catalog/ingest.ts) as claims; ingestion resolves them against these objects and creates only
-- what is missing. Providers never own an id here: a Spotify, Deezer or YouTube id is one
-- representation (catalog_source_object) of a Curator object.
--
-- Two lifetimes. Static objects (recording, release) are created once and enriched once: facts are
-- write-once per (field, source) and the object's attributes take a field only while it is empty,
-- so a provider disagreeing later changes nothing. Live objects (artist, label, playlist, genre,
-- chart) keep producing and are the only ones tracked: catalog_cursor rows exist only while someone
-- watches the object, and a new child a tracker finds becomes a static object and, when recent, a
-- catalog_event. Imports populate the catalogue and never raise events.
--
-- Access. These tables are shared across accounts and none is readable by `authenticated`: the API
-- and the worker read and write them as `curator_api` (grants in sql/roles.sql), and what a user may
-- see leaves through the tRPC procedures only. The one per-user table, catalog_watch, keeps the RLS
-- pattern of every other user table and is written as the user (src/catalog/watches.ts).

-- ── objects ──────────────────────────────────────────────────────────────────────────────────
create table curator.catalog_object (
	id uuid primary key default gen_random_uuid(),
	kind text not null check (kind in ('artist', 'label', 'release', 'recording', 'playlist', 'genre', 'chart')),
	name text not null check (char_length(name) between 1 and 500),
	-- nameFold (packages/library-logic): what search and the conservative matchers compare.
	name_fold text not null,
	-- The folded current attributes (src/catalog/fold.ts): one read for a page or a card.
	attrs jsonb not null default '{}'::jsonb,
	-- A merge redirects the loser here; readers follow the chain (src/catalog/identity.ts).
	merged_into uuid references curator.catalog_object (id),
	-- Kept by the catalog_watch trigger below; > 0 is what keeps an object's trackers alive.
	watch_count integer not null default 0 check (watch_count >= 0),
	-- When Curator learned of it, and how. Not the release date: an import learns of old releases.
	discovered_at timestamptz not null default now(),
	discovered_via text not null check (discovered_via in ('library_import', 'playlist_import', 'manual_registration', 'tracker', 'enrichment', 'migration')),
	updated_at timestamptz not null default now(),
	-- recording: length, and recordingKey (title + artist set, version kept) for the name matcher.
	duration_sec real,
	rec_key text,
	-- release: when it came out (midnight UTC of the most precise date known) and its type.
	release_at timestamptz,
	release_type text,
	-- release: the label as a bare string, from a provider without a label entity. Never a label
	-- object: labels, like artists, are never created or merged on a name alone.
	label_text text,
	-- playlist: the provider it lives on (a playlist is provider-local).
	home_provider text,
	check (merged_into is null or merged_into <> id)
);
create index catalog_object_kind_name on curator.catalog_object (kind, name_fold text_pattern_ops);
create index catalog_object_rec_key on curator.catalog_object (rec_key) where kind = 'recording';
create index catalog_object_merged on curator.catalog_object (merged_into) where merged_into is not null;
create index catalog_object_watched on curator.catalog_object (kind) where watch_count > 0;

-- How provider P represents object O. The same provider id may name different kinds (numeric ids
-- across entity types), hence the kind in the key.
create table curator.catalog_source_object (
	id uuid primary key default gen_random_uuid(),
	object_id uuid not null references curator.catalog_object (id),
	provider text not null,
	kind text not null,
	provider_id text not null check (char_length(provider_id) between 1 and 200),
	url text,
	-- What the provider said when first seen (refreshed for live objects only).
	payload jsonb,
	first_seen_at timestamptz not null default now(),
	last_seen_at timestamptz not null default now(),
	confidence real not null default 1 check (confidence between 0 and 1),
	unique (provider, kind, provider_id)
);
create index catalog_source_object_object on curator.catalog_source_object (object_id);

-- Global identifiers, apart from representations: an ISRC names a recording, a UPC a release,
-- whoever reported it.
create table curator.catalog_identifier (
	namespace text not null,
	value text not null,
	object_id uuid not null references curator.catalog_object (id),
	source_object_id uuid references curator.catalog_source_object (id) on delete set null,
	confidence real not null default 1 check (confidence between 0 and 1),
	at timestamptz not null default now(),
	primary key (namespace, value)
);
create index catalog_identifier_object on curator.catalog_identifier (object_id);

-- Each source's value for a field, written once. Disagreement is kept (several sources, one row
-- each); there is no history: a source's later value for a static object is not interesting.
create table curator.catalog_fact (
	object_id uuid not null references curator.catalog_object (id),
	field text not null,
	source text not null,
	value jsonb not null,
	confidence real not null default 1 check (confidence between 0 and 1),
	method text not null default 'provider_metadata'
		check (method in ('provider_metadata', 'audio_analysis', 'community_metadata', 'user_contributed', 'inferred')),
	at timestamptz not null default now(),
	primary key (object_id, field, source)
);

-- Canonical relationships, one row each, with the sources that asserted them beside.
create table curator.catalog_edge (
	id uuid primary key default gen_random_uuid(),
	src uuid not null references curator.catalog_object (id),
	kind text not null check (kind in ('artist-release', 'release-recording', 'recording-artist', 'release-label', 'object-genre', 'similar-artist')),
	dst uuid not null references curator.catalog_object (id),
	role text,
	position integer,
	at timestamptz not null default now(),
	unique (src, kind, dst)
);
create index catalog_edge_dst on curator.catalog_edge (dst, kind);
create table curator.catalog_edge_evidence (
	edge_id uuid not null references curator.catalog_edge (id) on delete cascade,
	source_object_id uuid not null references curator.catalog_source_object (id) on delete cascade,
	confidence real not null default 1 check (confidence between 0 and 1),
	at timestamptz not null default now(),
	primary key (edge_id, source_object_id)
);

-- Playlist membership is temporal and provider-local (phase 4 trackers write it).
create table curator.catalog_playlist_item (
	id uuid primary key default gen_random_uuid(),
	playlist_id uuid not null references curator.catalog_object (id),
	recording_id uuid not null references curator.catalog_object (id),
	position integer,
	added_at timestamptz,
	removed_at timestamptz,
	source_object_id uuid references curator.catalog_source_object (id) on delete set null
);
create index catalog_playlist_item_live on curator.catalog_playlist_item (playlist_id) where removed_at is null;

-- Genres: Beatport's taxonomy is the canonical universe (seeded by 0012); provider genre strings
-- map onto it through genre_alias, or stay orthogonal (genre_id null).
create table curator.catalog_genre (
	object_id uuid primary key references curator.catalog_object (id),
	slug text not null unique,
	parent_id uuid references curator.catalog_genre (object_id)
);
create table curator.genre_alias (
	provider text not null,
	raw_fold text not null,
	genre_id uuid references curator.catalog_genre (object_id),
	confidence real not null default 1 check (confidence between 0 and 1),
	primary key (provider, raw_fold)
);

-- Identity decisions an operator made, so a rejected match is never rediscovered, and the log of
-- merges with what each rested on (a provider purge flags merges that relied on it).
create table curator.catalog_not_same (
	object_a uuid not null references curator.catalog_object (id),
	object_b uuid not null references curator.catalog_object (id),
	reason text,
	by_whom text not null,
	at timestamptz not null default now(),
	primary key (object_a, object_b),
	check (object_a < object_b)
);
create table curator.catalog_merge_log (
	id bigint generated always as identity primary key,
	from_id uuid not null,
	into_id uuid not null,
	reason text not null,
	by_whom text not null,
	at timestamptz not null default now(),
	evidence jsonb not null default '{}'::jsonb,
	undo jsonb not null default '{}'::jsonb,
	flagged text
);

-- Time series on live objects (chart rank, hype, reposts): signals, not facts (phase 2).
create table curator.catalog_signal (
	id bigint generated always as identity primary key,
	object_id uuid not null references curator.catalog_object (id),
	source_object_id uuid references curator.catalog_source_object (id) on delete set null,
	kind text not null,
	value jsonb not null,
	observed_at timestamptz not null default now(),
	expires_at timestamptz
);
create index catalog_signal_object on curator.catalog_signal (object_id, observed_at desc);

-- The audio a recording was analysed from (phase 2 hangs shared analysis off it).
create table curator.catalog_audio (
	audio_hash text primary key,
	recording_id uuid not null references curator.catalog_object (id),
	duration_sec real,
	confidence real not null default 1 check (confidence between 0 and 1)
);

-- ── ingestion and enrichment ─────────────────────────────────────────────────────────────────
-- A batch of claims, once: the same producer resending the same key gets the first answer.
create table curator.catalog_ingest_batch (
	producer text not null,
	idempotency_key text not null,
	reason text not null,
	claims integer not null,
	created integer not null,
	attached integer not null,
	result jsonb not null,
	done_at timestamptz not null default now(),
	primary key (producer, idempotency_key)
);

-- Gaps ingestion found and the planner fills (empty fields only).
create table curator.catalog_enrich_task (
	object_id uuid not null references curator.catalog_object (id),
	need text not null,
	provider text not null,
	next_due_at timestamptz not null default now(),
	lease_holder text,
	lease_until timestamptz,
	attempts integer not null default 0,
	last_error text,
	primary key (object_id, need, provider)
);
create index catalog_enrich_task_due on curator.catalog_enrich_task (provider, next_due_at);

-- ── events ───────────────────────────────────────────────────────────────────────────────────
-- What devices read (feed.events). One per static object, ever: a second provider reporting the
-- same release adds a representation, never a second event.
create table curator.catalog_event (
	seq bigint generated always as identity primary key,
	kind text not null check (kind in ('new_release', 'reissue', 'playlist_add')),
	subject_id uuid not null references curator.catalog_object (id),
	dedupe_key text not null unique,
	release_at timestamptz,
	source_published_at timestamptz,
	first_seen_at timestamptz not null default now(),
	recordings_new integer not null default 0,
	confidence real not null check (confidence between 0 and 1),
	card jsonb not null
);
create index catalog_event_first_seen on curator.catalog_event (first_seen_at);
-- The watchable objects an event concerns; the fan-out joins watches on these.
create table curator.catalog_event_subject (
	seq bigint not null references curator.catalog_event (seq) on delete cascade,
	object_id uuid not null references curator.catalog_object (id),
	primary key (seq, object_id)
);
create index catalog_event_subject_object on curator.catalog_event_subject (object_id, seq);

-- ── tracking ─────────────────────────────────────────────────────────────────────────────────
-- What the admin configures: which provider tracks which kind, how often, within what budget.
-- `cadence`: { everyMin, friday: { fromUtc: 'HH:MM', toUtc: 'HH:MM', everyMin } }; `budget`:
-- { perDay, minGapMs }; `config`: adapter options (src/catalog/trackers).
create table curator.tracker (
	kind text not null,
	provider text not null,
	enabled boolean not null default true,
	cadence jsonb not null,
	budget jsonb not null,
	config jsonb not null default '{}'::jsonb,
	updated_by text,
	updated_at timestamptz not null default now(),
	primary key (kind, provider)
);

-- One per (watched live object, tracking provider). Exists only while tracking is active; existence
-- in the catalogue never creates one by itself. `tracking_started_at` is what keeps a first poll
-- from announcing an artist's back catalogue.
create table curator.catalog_cursor (
	object_id uuid not null references curator.catalog_object (id),
	provider text not null,
	cursor jsonb not null default '{}'::jsonb,
	tracking_started_at timestamptz not null default now(),
	next_due_at timestamptz not null default now(),
	lease_holder text,
	lease_until timestamptz,
	fail_count integer not null default 0,
	last_run_at timestamptz,
	last_error text,
	primary key (object_id, provider)
);
create index catalog_cursor_due on curator.catalog_cursor (provider, next_due_at);

-- A provider's calls per UTC day, reserved before they are made, so several workers never
-- overspend one quota between them (catalog_reserve_calls).
create table curator.provider_budget (
	provider text not null,
	day date not null,
	units_used integer not null default 0 check (units_used >= 0),
	primary key (provider, day)
);

create table curator.tracker_run (
	id bigint generated always as identity primary key,
	kind text not null,
	provider text not null,
	worker text not null,
	started_at timestamptz not null default now(),
	finished_at timestamptz,
	claimed integer not null default 0,
	calls integer not null default 0,
	events integer not null default 0,
	failed integer not null default 0,
	errors jsonb not null default '[]'::jsonb
);

-- Who may change trackers and identity decisions through admin.* (owner inserts by SQL).
create table curator.admin_user (
	user_id uuid primary key references auth.users (id) on delete cascade,
	added_at timestamptz not null default now()
);

-- ── watches (per user, RLS) ──────────────────────────────────────────────────────────────────
create table curator.catalog_watch (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	object_id uuid not null references curator.catalog_object (id),
	source text not null check (source in ('manual', 'suggested', 'imported')),
	muted boolean not null default false,
	created_at timestamptz not null default now(),
	primary key (user_id, object_id)
);
create index catalog_watch_object on curator.catalog_watch (object_id);

alter table curator.catalog_watch enable row level security;
create policy catalog_watch_select on curator.catalog_watch for select to authenticated using (user_id = (select auth.uid()));
create policy catalog_watch_insert on curator.catalog_watch for insert to authenticated with check (user_id = (select auth.uid()));
create policy catalog_watch_update on curator.catalog_watch for update to authenticated
	using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy catalog_watch_delete on curator.catalog_watch for delete to authenticated using (user_id = (select auth.uid()));
grant select, insert, delete on curator.catalog_watch to authenticated;
grant update (muted) on curator.catalog_watch to authenticated;

-- The watch count lives on the shared object, which `authenticated` cannot write: a definer
-- function keeps it, touching that one column of the one object the watch row names.
create function curator.catalog_watch_count() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op = 'INSERT' then
		update curator.catalog_object set watch_count = watch_count + 1 where id = new.object_id;
	elsif tg_op = 'DELETE' then
		update curator.catalog_object set watch_count = greatest(watch_count - 1, 0) where id = old.object_id;
	end if;
	return null;
end;
$$;
revoke execute on function curator.catalog_watch_count() from public, anon, authenticated;
create trigger catalog_watch_count after insert or delete on curator.catalog_watch
	for each row execute function curator.catalog_watch_count();

-- Reserves up to `p_want` calls of today's `p_cap` for `p_provider`; returns how many it got.
-- One row per provider per day, locked for the increment, so concurrent workers share it exactly.
create function curator.catalog_reserve_calls(p_provider text, p_want integer, p_cap integer) returns integer
language plpgsql
set search_path = ''
as $$
declare
	today date := (now() at time zone 'utc')::date;
	used integer;
	granted integer;
begin
	insert into curator.provider_budget (provider, day) values (p_provider, today) on conflict do nothing;
	select units_used into used from curator.provider_budget where provider = p_provider and day = today for update;
	granted := greatest(0, least(p_want, p_cap - used));
	if granted > 0 then
		update curator.provider_budget set units_used = units_used + granted where provider = p_provider and day = today;
	end if;
	return granted;
end;
$$;
revoke execute on function curator.catalog_reserve_calls(text, integer, integer) from public, anon, authenticated;
