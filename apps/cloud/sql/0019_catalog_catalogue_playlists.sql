-- Curator cloud, migration 0019: labels' catalogue playlists on Spotify.
--
-- A label's "all releases" playlist (src/catalog/profile/catalogue-playlists.ts) gives its whole
-- catalogue Spotify ids in a few calls and, tracked afterwards, its new releases. A candidate in
-- the middle band of the overlap check is a `label_playlist` review for the back office.

alter table curator.catalog_review drop constraint catalog_review_kind_check;
alter table curator.catalog_review add constraint catalog_review_kind_check
	check (kind in ('label_page', 'artist_link', 'duplicate', 'label_playlist'));

-- The overlap check reads a label's releases by the label string as well as by edge.
create index if not exists catalog_object_label_text on curator.catalog_object (lower(label_text)) where kind = 'release' and label_text is not null;

-- The label's Spotify tracker reads its catalogue playlists; a label gets a cursor once it has
-- one (src/catalog/watches.ts, requires 'catalogue_playlist'). Weekly, in the Friday window.
insert into curator.tracker (kind, provider, enabled, cadence, budget, config) values
	('label', 'spotify', true,
		'{"everyMin": 10080, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 180}}',
		'{"perDay": 40000, "minGapMs": 350}', '{"eventWindowDays": 14, "requires": "catalogue_playlist"}')
on conflict (kind, provider) do nothing;

-- The playlists the old rule linked (a playlist whose owner's name was the label's) go: the
-- overlap check decides from here on, and finds them again if they are the label's catalogue.
delete from curator.catalog_edge where kind = 'label-playlist' and role is null;

-- Every label gets the step; it waits for the label's profile and backfills.
insert into curator.catalog_enrich_task (object_id, need, provider)
select o.id, 'catalogue_playlists', 'spotify' from curator.catalog_object o
where o.kind = 'label' and o.merged_into is null
on conflict do nothing;
