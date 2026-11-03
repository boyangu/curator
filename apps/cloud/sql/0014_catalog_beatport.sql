-- Curator cloud, migration 0014: labels and genres tracked through Beatport's pages.
--
-- Beatport (src/catalog/trackers/beatport.ts) reads a label's releases (with UPCs, then each new
-- release's tracks with ISRCs) and a genre's weekly top 100. A genre's chart entries raise a new
-- event kind, `chart_entry`, one per (genre, recording) ever, with the membership and rank kept in
-- catalog_chart_entry (like catalog_playlist_item for playlists).

alter table curator.catalog_event drop constraint catalog_event_kind_check;
alter table curator.catalog_event add constraint catalog_event_kind_check
	check (kind in ('new_release', 'reissue', 'playlist_add', 'chart_entry'));

create table curator.catalog_chart_entry (
	genre_id uuid not null references curator.catalog_object (id),
	provider text not null,
	recording_id uuid not null references curator.catalog_object (id),
	rank integer not null,
	best_rank integer not null,
	first_seen_at timestamptz not null default now(),
	last_seen_at timestamptz not null default now(),
	primary key (genre_id, provider, recording_id)
);
create index catalog_chart_entry_recording on curator.catalog_chart_entry (recording_id);

-- The taxonomy's genres on Beatport (ids read from beatport.com/genre/<slug>/<id> on 2026-10-27;
-- the site resolves a genre by id, the slug is decoration). Two names differ: Beatport files
-- 'DJ Tools' as 'DJ Tools / Acapellas' and 'R&B' under the slug 'rb'.
with ids (slug, beatport_id, beatport_slug) as (values
	('140-deep-dubstep-grime', 95, '140-deep-dubstep-grime'),
	('afro-house', 89, 'afro-house'),
	('amapiano', 98, 'amapiano'),
	('ambient-experimental', 100, 'ambient-experimental'),
	('bass-club', 85, 'bass-club'),
	('bass-house', 91, 'bass-house'),
	('brazilian-funk', 101, 'brazilian-funk'),
	('breaks-breakbeat-uk-bass', 9, 'breaks-breakbeat-uk-bass'),
	('dance-pop', 39, 'dance-pop'),
	('deep-house', 12, 'deep-house'),
	('dj-tools', 16, 'dj-tools-acapellas'),
	('downtempo', 63, 'downtempo'),
	('drum-bass', 1, 'drum-bass'),
	('dubstep', 18, 'dubstep'),
	('electro-classic-detroit-modern', 94, 'electro-classic-detroit-modern'),
	('electronica', 3, 'electronica'),
	('funky-house', 81, 'funky-house'),
	('hard-dance-hardcore-neo-rave', 8, 'hard-dance-hardcore-neo-rave'),
	('hard-techno', 2, 'hard-techno'),
	('house', 5, 'house'),
	('indie-dance', 37, 'indie-dance'),
	('jackin-house', 97, 'jackin-house'),
	('mainstage', 96, 'mainstage'),
	('melodic-house-techno', 90, 'melodic-house-techno'),
	('minimal-deep-tech', 14, 'minimal-deep-tech'),
	('nu-disco-disco', 50, 'nu-disco-disco'),
	('organic-house', 93, 'organic-house'),
	('progressive-house', 15, 'progressive-house'),
	('psy-trance', 13, 'psy-trance'),
	('tech-house', 11, 'tech-house'),
	('techno-peak-time-driving', 6, 'techno-peak-time-driving'),
	('techno-raw-deep-hypnotic', 92, 'techno-raw-deep-hypnotic'),
	('trance-main-floor', 7, 'trance-main-floor'),
	('trance-raw-deep-hypnotic', 99, 'trance-raw-deep-hypnotic'),
	('trap-future-bass', 38, 'trap-future-bass'),
	('uk-garage-bassline', 86, 'uk-garage-bassline'),
	('african', 102, 'african'),
	('caribbean', 103, 'caribbean'),
	('country', 104, 'country'),
	('hip-hop', 105, 'hip-hop'),
	('latin', 106, 'latin'),
	('pop', 107, 'pop'),
	('r-b', 108, 'rb'),
	('rock', 109, 'rock')
)
insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url)
select g.object_id, 'beatport', 'genre', ids.beatport_id::text, 'https://www.beatport.com/genre/' || ids.beatport_slug || '/' || ids.beatport_id
from ids join curator.catalog_genre g on g.slug = ids.slug
on conflict (provider, kind, provider_id) do nothing;

-- Weekly, landing in the Friday morning window (UTC) when the week's releases are up and the
-- charts have turned. A label: its releases page, up to three pages on the first poll, plus up to
-- four release pages for new releases; a genre: one page. The daily budget is pages.
insert into curator.tracker (kind, provider, enabled, cadence, budget, config) values
	('label', 'beatport', true,
		'{"everyMin": 10080, "friday": {"fromUtc": "02:00", "toUtc": "12:00", "everyMin": 10080}}',
		'{"perDay": 3000, "minGapMs": 1500}', '{"eventWindowDays": 14, "requires": "representation"}'),
	('genre', 'beatport', true,
		'{"everyMin": 10080, "friday": {"fromUtc": "02:00", "toUtc": "12:00", "everyMin": 10080}}',
		'{"perDay": 500, "minGapMs": 1500}', '{"eventWindowDays": 14, "requires": "representation"}')
on conflict (kind, provider) do nothing;

-- Labels and genres already watched get their cursor now.
insert into curator.catalog_cursor (object_id, provider)
select o.id, 'beatport'
from curator.catalog_object o
where o.kind in ('label', 'genre') and o.watch_count > 0 and o.merged_into is null
	and exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = 'beatport')
on conflict do nothing;
