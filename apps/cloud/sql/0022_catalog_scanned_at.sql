-- Curator cloud, migration 0022: when an object's listing was last read for new releases.
--
-- A label (or artist) is scanned when a tracker's poll of it succeeds, a backfill run reads its
-- listing, or a back-office agent browses its pages and imports what it found (or records that it
-- found nothing: `catalog label scanned`). The back office sorts labels by it to see which have
-- gone longest unread. Null: never scanned.
alter table curator.catalog_object add column scanned_at timestamptz;
create index catalog_object_scanned on curator.catalog_object (kind, scanned_at) where merged_into is null;

-- What the trackers already know: each object's latest successful run.
update curator.catalog_object o set scanned_at = c.at
from (select object_id, max(last_run_at) as at from curator.catalog_cursor where last_error is null and last_run_at is not null group by object_id) c
where c.object_id = o.id;
