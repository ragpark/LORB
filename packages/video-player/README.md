# Video player

One reusable native-web-package player for video, following the quiz-player pattern: it contains
**no video content**; it renders a structured JSON payload fetched at runtime from
`GET /api/v1/runtime/learning-objects/:objectId/content`.

Two source kinds:

- `file` — an `.mp4`/`.webm` served from a runtime-controlled origin, played with a native
  `<video>` element. Progress is tracked automatically.
- `youtube` — embedded via `youtube-nocookie.com/embed/:video_id`. The content payload carries only
  a `video_id`, never an arbitrary embed URL, so this cannot become a way to smuggle a foreign
  origin into the sandboxed launch.

## Evidence

On a `file` source, over the Player Shell's `evidence.emit` channel:

1. `launched` — once, when the content payload has loaded.
2. `answered` — one per watch-quartile reached (`result.response` of `p25`, `p50`, `p75`), reusing
   the existing verb rather than widening the Evidence API's accepted verb set.
3. `completed` — once, on end-of-video or "Mark as watched".

On a `youtube` source: `launched` and `completed` only. See "Known limitations".

## Known limitations

- **No progress data for YouTube embeds.** The sandboxed iframe cannot observe playback state
  inside a nested cross-origin YouTube iframe without integrating the YouTube IFrame Player API
  (which itself needs `allow-same-origin` semantics this player deliberately doesn't have). Learners
  self-report completion via "Mark as watched" for that source kind only.
- **Completion is self-reported, not proctored**, for both source kinds — same trust model as
  quiz-player's client-side marking, and suitable for the same formative use.
- Requires the runtime's Content-Security-Policy `frame-src` to permit `youtube-nocookie.com` for
  the `youtube` source kind to render at all.
