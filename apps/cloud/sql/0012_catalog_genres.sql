-- Curator cloud, migration 0012: the canonical genres.
--
-- Beatport's genre list is the catalogue's genre universe (2026-10-26 decision): DJs already file
-- their libraries by it (Guy's library's genre strings are Beatport's almost to the letter). Each
-- genre is a live catalog_object (kind 'genre', trackable in phase 4) with a catalog_genre row; the
-- Beatport ids attach as representations once the Beatport adapter exists, so none are invented here.
--
-- genre_alias maps other providers' strings onto these. A string with no fit stays a fact on the
-- object and is never forced into the taxonomy (genre_id null = orthogonal, e.g. Deezer's 'Electro').
-- The `raw_fold` keys are nameFold (packages/library-logic) of the provider's string.

create temporary table genre_seed (slug text, name text) on commit drop;
insert into genre_seed (slug, name) values
	('140-deep-dubstep-grime', '140 / Deep Dubstep / Grime'),
	('afro-house', 'Afro House'),
	('amapiano', 'Amapiano'),
	('ambient-experimental', 'Ambient / Experimental'),
	('bass-club', 'Bass / Club'),
	('bass-house', 'Bass House'),
	('brazilian-funk', 'Brazilian Funk'),
	('breaks-breakbeat-uk-bass', 'Breaks / Breakbeat / UK Bass'),
	('dance-pop', 'Dance / Pop'),
	('deep-house', 'Deep House'),
	('dj-tools', 'DJ Tools'),
	('downtempo', 'Downtempo'),
	('drum-bass', 'Drum & Bass'),
	('dubstep', 'Dubstep'),
	('electro-classic-detroit-modern', 'Electro (Classic / Detroit / Modern)'),
	('electronica', 'Electronica'),
	('funky-house', 'Funky House'),
	('hard-dance-hardcore-neo-rave', 'Hard Dance / Hardcore / Neo Rave'),
	('hard-techno', 'Hard Techno'),
	('house', 'House'),
	('indie-dance', 'Indie Dance'),
	('jackin-house', 'Jackin House'),
	('mainstage', 'Mainstage'),
	('melodic-house-techno', 'Melodic House & Techno'),
	('minimal-deep-tech', 'Minimal / Deep Tech'),
	('nu-disco-disco', 'Nu Disco / Disco'),
	('organic-house', 'Organic House'),
	('progressive-house', 'Progressive House'),
	('psy-trance', 'Psy-Trance'),
	('tech-house', 'Tech House'),
	('techno-peak-time-driving', 'Techno (Peak Time / Driving)'),
	('techno-raw-deep-hypnotic', 'Techno (Raw / Deep / Hypnotic)'),
	('trance-main-floor', 'Trance (Main Floor)'),
	('trance-raw-deep-hypnotic', 'Trance (Raw / Deep / Hypnotic)'),
	('trap-future-bass', 'Trap / Future Bass'),
	('uk-garage-bassline', 'UK Garage / Bassline'),
	('african', 'African'),
	('caribbean', 'Caribbean'),
	('country', 'Country'),
	('hip-hop', 'Hip-Hop'),
	('latin', 'Latin'),
	('pop', 'Pop'),
	('r-b', 'R&B'),
	('rock', 'Rock');

-- name_fold mirrors nameFold: lower case, & read as 'and', every other run of non-alphanumerics
-- one space.
with made as (
	insert into curator.catalog_object (kind, name, name_fold, discovered_via)
	select 'genre', s.name,
		btrim(regexp_replace(replace(lower(s.name), '&', ' and '), '[^a-z0-9]+', ' ', 'g')),
		'migration'
	from genre_seed s
	returning id, name
)
insert into curator.catalog_genre (object_id, slug)
select m.id, s.slug from made m join genre_seed s on s.name = m.name;

-- Each canonical name maps to itself for Beatport and for the strings libraries carry.
insert into curator.genre_alias (provider, raw_fold, genre_id)
select p.provider, o.name_fold, g.object_id
from curator.catalog_genre g
join curator.catalog_object o on o.id = g.object_id
cross join (values ('beatport'), ('beatsource'), ('user'), ('traxsource')) as p (provider);

-- Strings seen in libraries and on other providers, onto the taxonomy.
create temporary table genre_alias_seed (provider text, raw text, slug text) on commit drop;
insert into genre_alias_seed (provider, raw, slug) values
	('user', 'melodic progressive house', 'progressive-house'),
	('user', 'indie tech', 'indie-dance'),
	('user', 'lounge chill out', 'downtempo'),
	('user', 'nu disco indie dance', 'indie-dance'),
	('user', 'broken beat nu jazz', 'breaks-breakbeat-uk-bass'),
	('user', 'techno', 'techno-peak-time-driving'),
	('user', 'trance', 'trance-main-floor'),
	('traxsource', 'melodic progressive house', 'progressive-house'),
	('traxsource', 'indie tech', 'indie-dance'),
	('traxsource', 'lounge chill out', 'downtempo'),
	('traxsource', 'nu disco indie dance', 'indie-dance'),
	('traxsource', 'broken beat nu jazz', 'breaks-breakbeat-uk-bass'),
	('spotify', 'melodic house', 'melodic-house-techno'),
	('spotify', 'melodic techno', 'melodic-house-techno'),
	('spotify', 'organic house', 'organic-house'),
	('spotify', 'afro house', 'afro-house'),
	('spotify', 'deep house', 'deep-house'),
	('spotify', 'progressive house', 'progressive-house'),
	('spotify', 'tech house', 'tech-house'),
	('spotify', 'indie dance', 'indie-dance'),
	('spotify', 'nu disco', 'nu-disco-disco'),
	('spotify', 'minimal techno', 'minimal-deep-tech'),
	('spotify', 'electronica', 'electronica'),
	('spotify', 'downtempo', 'downtempo'),
	('spotify', 'amapiano', 'amapiano'),
	('spotify', 'drum and bass', 'drum-bass'),
	('spotify', 'dubstep', 'dubstep'),
	('spotify', 'uk garage', 'uk-garage-bassline'),
	('spotify', 'psytrance', 'psy-trance'),
	('spotify', 'hard techno', 'hard-techno');
insert into curator.genre_alias (provider, raw_fold, genre_id, confidence)
select a.provider, a.raw, g.object_id, 0.8
from genre_alias_seed a join curator.catalog_genre g on g.slug = a.slug
on conflict do nothing;

-- Deezer's genres are too broad to place: kept as facts, orthogonal to the taxonomy.
insert into curator.genre_alias (provider, raw_fold, genre_id, confidence) values
	('deezer', 'electro', null, 1),
	('deezer', 'dance', null, 1),
	('deezer', 'pop', null, 1)
on conflict do nothing;

-- The tracker defaults the admin starts from (admin.trackers.set / the catalog CLI change them).
-- A tracker whose adapter is not configured on the worker (no key) is skipped, not failed.
-- `requires`: 'representation' tracks an object only once it has an id on that provider; 'name'
-- tracks it by name (Deezer finds a label's releases by searching its name).
insert into curator.tracker (kind, provider, enabled, cadence, budget, config) values
	('artist', 'spotify', true,
		'{"everyMin": 1440, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 120}}',
		'{"perDay": 40000, "minGapMs": 350}', '{"eventWindowDays": 14, "requires": "representation"}'),
	('artist', 'deezer', true,
		'{"everyMin": 1440, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 120}}',
		'{"perDay": 200000, "minGapMs": 130}', '{"eventWindowDays": 14, "requires": "representation"}'),
	('label', 'youtube', true,
		'{"everyMin": 720, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 120}}',
		'{"perDay": 9000, "minGapMs": 200}', '{"eventWindowDays": 14, "requires": "representation"}'),
	('label', 'deezer', true,
		'{"everyMin": 1440, "friday": {"fromUtc": "00:00", "toUtc": "12:00", "everyMin": 180}}',
		'{"perDay": 200000, "minGapMs": 130}', '{"eventWindowDays": 14, "requires": "name"}');
