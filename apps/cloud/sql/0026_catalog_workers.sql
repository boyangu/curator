-- Curator cloud, migration 0026: desktops as catalogue workers.
--
-- A desktop reads the catalogue's providers for the objects its user follows and reports each
-- poll (catalog.workerDue / workerReport, src/catalog/workers.ts); the cloud applies a reported
-- poll as it applies its own. One worker per user per week: the row names the device that
-- holds it. The cursor set is the user's watches, joined at lease time; nothing is stamped on
-- the cursors themselves, so the week rolls over and a stale device is replaced in one upsert.
create table curator.catalog_worker (
	user_id uuid primary key references auth.users (id) on delete cascade,
	device_id text not null,
	-- The providers the device said it can read (never youtube or soundcloud: their keys are the cloud's).
	providers text[] not null,
	-- The Monday (UTC) of the week the device holds.
	week_of date not null,
	checked_in_at timestamptz not null default now(),
	foreign key (user_id, device_id) references curator.device (user_id, device_id) on delete cascade
);

-- Who reported the poll a cursor's last_run_at / last_error describe: the cloud's holder
-- (host:pid) or `device:<id>`. A device's rate limit must not park the cloud's reads
-- (tracking.ts providerPauses), and the back office says who read what.
alter table curator.catalog_cursor add column last_reported_by text;
-- Who raised an event (same strings), for provenance and a purge by device later.
alter table curator.catalog_event add column raised_by text;
