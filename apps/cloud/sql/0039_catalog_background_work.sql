-- Curator cloud, migration 0039: background work — the account's main desktop completes what the
-- weekly reads found, on the check it already makes every minute (src/catalog/work/background.ts,
-- feature 'catalog_background_work').

-- The read cadence is the operator's, one for everyone (catalog_setting read.cadence.*): a desktop's
-- own choice is no longer kept.
alter table curator.catalog_worker drop column cadence;

-- Releases waiting for an account's main desktop: what its weekly reads created, to be completed
-- (tracklist, store pages, track facts) as work on its next checks. A row leaves once the planner
-- finds nothing more to ask of the release, whoever answered it meanwhile.
create table curator.catalog_work_queue (
	user_id uuid not null,
	object_id uuid not null references curator.catalog_object (id),
	-- What put it here: 'weekly' (a weekly read created the release).
	reason text not null,
	queued_at timestamptz not null default now(),
	primary key (user_id, object_id)
);
create index catalog_work_queue_oldest on curator.catalog_work_queue (user_id, queued_at);

-- A background job handed to a device, held until it reports or the lease lapses, so the next check
-- does not hand it again. Page work is never leased.
create table curator.catalog_work_lease (
	job_id text primary key,
	user_id uuid not null,
	device_id text not null,
	until timestamptz not null
);
