# @curator/matcher

Decides whether a candidate from an external source (Beatport, Traxsource) is the **same
recording** as a track we already have, and scores how good the match is. Shared by the
enrichers so accept/reject logic lives in one place.

The core export is `Scorer`:

- `Scorer.score(target, candidate)` → `{ acceptable, score, signals }`
- `Scorer.normalize(s)` / `deaccent(s)` — lowercase, strip diacritics (ß→ss, ø→o, æ→ae, …),
  collapse whitespace/special chars
- `Scorer.baseTitle(title)` — strip version annotations (`(Original Mix)`, `- Original Mix`, …)

**Acceptance is strict:** an ISRC match alone, **or** (title match + artist match + duration
within 5s). Scoring weights ISRC highest (+1000), then title exact/partial, artist matches,
duration closeness, and version match — so the best candidate wins, but a weak one is rejected
rather than guessed.

Used by `@curator/beatport` and `@curator/traxsource`. Tidal matching is native; Spotify and
MusicBrainz use ISRC-pivot schemes of their own.
