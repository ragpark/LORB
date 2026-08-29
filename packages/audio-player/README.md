# Audio player

Reusable native-web-package player for a single audio track (podcast episode, spoken-word lesson,
narrated slide audio). No audio content of its own — renders the content payload fetched from
`GET /api/v1/runtime/learning-objects/:objectId/content`, same as quiz-player and video-player.

## Evidence

1. `launched` — once, on load.
2. `answered` — one per quarter of the track heard (`result.response`: `p25`/`p50`/`p75`), reusing
   the existing verb rather than widening the Evidence API.
3. `completed` — once, on end-of-track or "Mark as listened".

## Known limitations

- Completion is self-reported for the "Mark as listened" path — same trust model as quiz-player's
  client-side marking.
- No scrubbing-abuse detection: a learner who seeks straight to the end still gets quartile credit
  for positions they skipped past. Acceptable for formative use; not for anything requiring proof of
  full listen-through.
