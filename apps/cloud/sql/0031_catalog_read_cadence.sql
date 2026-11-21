-- Curator cloud, migration 0031: how often a user's follows are read.
--
-- The trackers' own cadences read a followed playlist hourly and a followed artist daily, tighter
-- through Friday: ~10,000 Spotify calls a day for one user's follows (2026-11-19), most of them
-- to learn nothing new — releases land on Friday. Settings → Discover now lets a user say, per
-- kind, how often their follows are read: once a week in the Friday window (the default), once a
-- day, or as often as the source allows. The device sends the choices with every workerDue
-- beside its checked trackers ({"artist": "weekly", "playlist": "daily", …}); a cursor's next
-- due time follows the most frequent choice among the followers who want it read
-- (trackers/cadence.ts nextDueFor, tracking.ts readCadenceOf). Null: the device never said (a
-- worker from before this column) — the default, weekly.
alter table curator.catalog_worker add column cadence jsonb;

-- The cursors as the old cadences left them are due within the hour or the day. Read once more
-- there, each would only then move to its weekly slot — one last wave of every follow. Moved now
-- instead: a cursor that has been read, is not backing off, and belongs to a tracker faster than
-- weekly waits for the Friday window that opens next (on a Friday, today's has opened and nothing
-- is due before it). A user who then chooses a faster cadence has theirs pulled back
-- (tracking.ts retimeCursors); a follow never read yet is still read at once.
update curator.catalog_cursor c
set next_due_at = f.opens + random() * interval '2 hours'
from curator.catalog_object o, curator.tracker t,
	(select date_trunc('day', now() at time zone 'utc') at time zone 'utc'
		+ make_interval(days => (12 - extract(dow from now() at time zone 'utc')::int) % 7) as opens) f
where o.id = c.object_id and t.kind = o.kind and t.provider = c.provider
	and (t.cadence ->> 'everyMin')::int < 10080
	and c.last_run_at is not null and c.last_error is null and c.next_due_at < f.opens;
