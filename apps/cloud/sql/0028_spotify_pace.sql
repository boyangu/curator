-- Spotify's rate limit is per client id, shared by the desktop worker and the
-- master's own readers; 350/400 ms gaps let a Friday wave of 1,842 artists
-- run at ~235 calls/min and earned the app a 3-hour quota ban (2026-11-06).
-- One poll a second per reader from here (the desktop's own gate and the
-- master's pace, catalog/spotify-pace.ts, bound the calls underneath).
update curator.tracker
set budget = budget || '{"minGapMs": 1000}'::jsonb
where provider = 'spotify' and kind in ('artist', 'label');

update curator.tracker
set budget = budget || '{"minGapMs": 1200}'::jsonb
where provider = 'spotify' and kind = 'playlist';
