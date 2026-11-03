-- Curator cloud, migration 0015: a label's profile and roster.
--
-- A watched label is profiled once (src/catalog/profile/label-profiler.ts): its pages elsewhere
-- (MusicBrainz and Discogs link lists, Beatport's label search, its homepage's outbound links,
-- Bandcamp's band details, SoundCloud's profile) become representations, which activate the
-- trackers that need one; its Spotify playlist, when it has one, is tracked for its watchers.
-- Bandcamp (src/catalog/trackers/bandcamp.ts) brings the roster: `label-artist` edges.

alter table curator.catalog_edge drop constraint catalog_edge_kind_check;
alter table curator.catalog_edge add constraint catalog_edge_kind_check
	check (kind in ('artist-release', 'release-recording', 'recording-artist', 'release-label', 'object-genre', 'similar-artist', 'label-artist', 'label-playlist'));

insert into curator.tracker (kind, provider, enabled, cadence, budget, config) values
	('label', 'bandcamp', true,
		'{"everyMin": 10080, "friday": {"fromUtc": "02:00", "toUtc": "12:00", "everyMin": 10080}}',
		'{"perDay": 2000, "minGapMs": 1500}', '{"eventWindowDays": 14, "requires": "representation"}')
on conflict (kind, provider) do nothing;

-- Labels watched before this migration get their profile pass now (a watch made from here on
-- queues it as it is made, src/catalog/watches.ts addWatch).
insert into curator.catalog_enrich_task (object_id, need, provider)
select o.id, 'profile', 'catalog'
from curator.catalog_object o
where o.kind = 'label' and o.watch_count > 0 and o.merged_into is null
on conflict do nothing;
