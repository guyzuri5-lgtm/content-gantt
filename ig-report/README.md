# IG Reels Report

Pulls your Instagram Reels + private insights via Composio and renders a
self-contained `report.html`.

## How this relates to the board

Since the two projects were unified, **the fetching lives in
[`../api/_lib/instagram.mjs`](../api/_lib/instagram.mjs)** — the exact module the
board's `/api/ig-refresh` endpoint runs. This folder is the local way to drive
it; the board's "analyze new reels" button is the hosted way. Neither has its
own copy of the pipeline, so they can't drift apart.

Day to day you probably want the board's button. Two things still bring you
here:

1. **The first-time Instagram authorization.** It's an interactive OAuth
   approval, so no server can do it for you. Running `npm run agent` once prints
   the link; after you approve it, the connection persists and the board's
   button works from any device.
2. **The standalone HTML report**, if you want the analysis as a file rather
   than inside the board.

## Re-run

```bash
npm run report
```

`agent.ts` (fetch → `data.json`) then `render.ts` (metrics + thumbnails →
`report.html`). Each runs on its own too: `npm run agent`, `npm run render`.

Custom window: `WINDOW_DAYS=90 npm run report` (also `FETCH_LIMIT`).

New reels merge into whatever `data.json` already holds — an older reel that
has aged out of the window is kept, not dropped.

## First run

1. Put your Composio key in `.env` in this folder:
   `COMPOSIO_API_KEY` — a **project-level** key from
   [platform.composio.dev](https://platform.composio.dev) → Project Settings →
   API Keys (not a `ck_...` consumer key — those are a different auth flow and
   will 401).
2. `npm install && npm run agent` — Instagram isn't connected yet, so it prints
   an authorization link and exits.
3. Open the link, log into Instagram, approve access.
4. Re-run. The connection persists from then on.

`ANTHROPIC_API_KEY` is no longer needed: the pipeline is a plain sequence of API
calls, so the Claude Agent SDK that used to drive it was removed.

## Files

- `agent.ts` — one-time Instagram authorization + fetch → `data.json`
- `render.ts` — `data.json` → thumbnails in `./thumbs/` + `report.html`
- `data.json`, `thumbs/`, `report.html` — generated, safe to delete and re-run

`data.json` uses the same canonical post shape the board stores in Supabase:

```
{ id, timestamp, date, mediaType, caption, permalink, thumbUrl, thumb,
  durationS, reach, views, likes, comments, shares, saved,
  totalInteractions, watchTimeS }
```
