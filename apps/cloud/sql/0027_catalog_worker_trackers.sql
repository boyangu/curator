-- Curator cloud, migration 0027: the user's tracking choices.
--
-- A desktop's Refresh menu lets its user switch each kind × source off ("artists on Deezer"):
-- unchecked means nobody reads it for that user's follows, the cloud included. The device sends
-- its checked trackers ('label/beatport', …) with every workerDue beside the providers it can
-- read right now; the lease looks at both (trackers/sweep.ts wantedSql): a cursor is read only
-- when some watcher wants it, and left to a device only when that device wants it AND can read
-- its provider. Null: the device never said (a worker from before this column) — defaults, all on.
alter table curator.catalog_worker add column trackers text[];
