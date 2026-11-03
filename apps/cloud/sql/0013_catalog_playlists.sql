-- Curator cloud, migration 0013: Spotify playlists tracked by the catalogue.
--
-- A watched Spotify playlist is read with one of its watchers' own Spotify
-- login (src/catalog/trackers/spotify-user-playlist.ts): Spotify serves a
-- playlist's items to people, not to an app. Its new additions become
-- `playlist_add` events (src/catalog/events.ts).
--
-- Hourly, every half hour on Friday mornings (UTC) when new music lands.
insert into curator.tracker (kind, provider, enabled, cadence, budget, config) values
	('playlist', 'spotify', true,
		'{"everyMin": 60, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 30}}',
		'{"perDay": 20000, "minGapMs": 400}', '{"eventWindowDays": 14, "requires": "representation"}')
on conflict (kind, provider) do nothing;

-- Playlists already watched get their cursor now (a watch made from here on
-- gets it when it is made, src/catalog/watches.ts ensureCursors).
insert into curator.catalog_cursor (object_id, provider)
select o.id, 'spotify'
from curator.catalog_object o
where o.kind = 'playlist' and o.watch_count > 0 and o.merged_into is null
	and exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = 'spotify')
on conflict do nothing;
