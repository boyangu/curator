-- Curator cloud, migration 0038: device work — the cloud plans, the device reads
-- (src/catalog/work/, packages/protocol catalog-work.ts, feature 'catalog_device_work').
--
-- A device sends what it can read with every catalogue read; the answer carries the store reads the
-- catalogue wants for what was just fetched; the device reports what it read. Nothing is leased: a
-- job handed to two devices is done by both, and the state below moves only when a report lands.

-- What the cloud is set to, changed without a release of anything (the back office's CLI writes it).
-- `scope` is '*' for everyone or one user's id, the user's row winning: the off switch for one
-- account is `work.enabled = false` under its id.
create table curator.catalog_setting (
	key text not null,
	scope text not null default '*',
	value jsonb not null,
	updated_by text not null default 'migration',
	updated_at timestamptz not null default now(),
	primary key (key, scope)
);

-- Shipped off: switched on per account first (0038 changes no device's behaviour by itself).
insert into curator.catalog_setting (key, value) values
	('work.enabled', 'false'),
	-- An artist's or a label's store page is read again after this many days.
	('work.find_days', '7'),
	-- A release's page on a store is confirmed again after this many days.
	('work.check_days', '90'),
	-- What a store did not have is asked again after this many days.
	('work.retry_days', '7'),
	-- Rounds of follow-up work one page visit may run.
	('work.rounds', '3'),
	-- The oldest reading code (a device's profile.reader) still handed work.
	('work.min_reader', '1'),
	-- Releases' worth of work one page visit is handed, by the form of device.
	('work.releases', '{"phone": 20, "desktop": 100}'),
	-- Calls a day per store, counted over everyone and everything that draws on provider_budget
	-- (the trackers and the store linker count on the same row): past it no work for that store is
	-- handed out until tomorrow.
	('work.per_day', '{"spotify": 15000, "deezer": 20000, "beatport": 5000, "bandcamp": 5000, "traxsource": 5000}');

-- What was last learned per job, the ages read against it, and the memory of "not found".
--   find     (artist | label, provider, page id)  the page's listing was read; `cursor` is the
--            reader's, handed back with the next job; outcome ok | more (unread releases remain)
--            | disagrees (a probe whose listing was not the object's: never read again)
--   page     (label, '*', '')                     how the label's two pages' listings compare, kept
--            a day in `evidence` so a page open does not walk its releases every time
--   release  (release, store, '')                 the release was looked for at a store it is not
--            on: not_found | unconfirmed (found, and the tracklists did not agree) | conflict (the
--            page found is another release's) | error (the store did not answer: asked again
--            after a day)
--   check    (object, provider, page id)          a page read: read (in full, its tracks kept) |
--            agrees | disagrees | gone | empty (no tracklist there) | error
--   facts    (recording, store, '')               ok | unplaced | not_found; (release, store, '')
--            error
create table curator.catalog_work_state (
	object_id uuid not null references curator.catalog_object (id),
	job text not null check (job in ('find', 'page', 'release', 'check', 'facts')),
	provider text not null,
	provider_id text not null default '',
	outcome text not null,
	answered_at timestamptz not null default now(),
	cursor jsonb,
	evidence jsonb,
	user_id uuid,
	device_id text,
	primary key (object_id, job, provider, provider_id)
);

-- Every report, and what each of its results touched: who put a store page or a release into the
-- catalogue, by account, device and job. Also the report's idempotency: a resend gets `result`.
create table curator.catalog_work_report (
	id bigint generated always as identity primary key,
	user_id uuid not null,
	device_id text not null,
	idempotency_key text not null,
	profile jsonb not null,
	calls jsonb not null default '{}'::jsonb,
	result jsonb,
	at timestamptz not null default now(),
	unique (user_id, idempotency_key)
);
-- The answers kept for resends are dropped after a day (retention.ts): the few that still hold one.
create index catalog_work_report_answered on curator.catalog_work_report (at) where result is not null;
create table curator.catalog_work_item (
	report_id bigint not null references curator.catalog_work_report (id) on delete cascade,
	job_id text not null,
	-- The object the job was about (null: one the report brought into the catalogue).
	object_id uuid,
	-- What the result stated: a store page, by its key in catalog_source_object.
	provider text not null,
	kind text not null,
	provider_id text not null,
	outcome text not null,
	primary key (report_id, job_id, provider, kind, provider_id)
);
-- "Who said this page is this object?", and everything one device put in.
create index catalog_work_item_ref on curator.catalog_work_item (provider, kind, provider_id);

-- Releases a device just reported, waiting for the stores only the cloud can ask (Tidal, Apple: by
-- UPC and ISRC with Curator's own keys). Drained by the API's own timer (src/catalog/work/followup.ts).
-- A release leaves the queue once every store has been asked. One a store could not be asked about
-- stays, with the stores that were (`asked`: never asked twice) and when to come back (`not_before`:
-- after the store's wait, or at the next day's count).
create table curator.catalog_work_followup (
	release_id uuid primary key references curator.catalog_object (id),
	queued_at timestamptz not null default now(),
	asked text[] not null default '{}',
	not_before timestamptz not null default now()
);
create index catalog_work_followup_due on curator.catalog_work_followup (not_before);
