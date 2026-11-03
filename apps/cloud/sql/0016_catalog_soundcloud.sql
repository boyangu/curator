-- Curator cloud, migration 0016: a label's SoundCloud uploads.
--
-- Read through SoundCloud's official API with the app's credentials
-- (src/catalog/trackers/soundcloud.ts); the YouTube row from 0012 serves the channel tracker
-- (src/catalog/trackers/youtube.ts). Daily, hourly on Friday mornings (UTC).
insert into curator.tracker (kind, provider, enabled, cadence, budget, config) values
	('label', 'soundcloud', true,
		'{"everyMin": 1440, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 60}}',
		'{"perDay": 12000, "minGapMs": 300}', '{"eventWindowDays": 14, "requires": "representation"}')
on conflict (kind, provider) do nothing;

insert into curator.catalog_cursor (object_id, provider)
select o.id, 'soundcloud'
from curator.catalog_object o
where o.kind = 'label' and o.watch_count > 0 and o.merged_into is null
	and exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = 'soundcloud')
on conflict do nothing;
