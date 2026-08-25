# IG Reels Report

Personal Instagram Reels analytics: pulls your last 14 days of Reels + private
insights via Composio's hosted MCP and the Claude Agent SDK, then renders a
self-contained `report.html` you open in a browser.

## Re-run

```bash
npm run report
```

That runs `agent.ts` (fetch + save `data.json`) followed by `render.ts`
(compute metrics, download thumbnails, write `report.html`). You can also run
each step on its own: `npm run agent` and `npm run render`.

## First run

1. Make sure both keys are set in `.env` in this folder:
   - `COMPOSIO_API_KEY` — a **project-level** API key from
     [platform.composio.dev](https://platform.composio.dev) → Project Settings
     → API Keys, with write access to sessions (not a `ck_...` consumer key —
     those are for a different auth flow and will 401).
   - `ANTHROPIC_API_KEY` — from
     [platform.claude.com](https://platform.claude.com) → Settings → API keys.
     The Agent SDK spawns its own Claude Code subprocess, which needs this
     even if you're already logged into Claude Code elsewhere.
2. `npm run report` (or `npm run agent`) — since Instagram isn't connected
   yet, it prints an authorization link and exits.
3. Open the link, log into Instagram, approve access.
4. Re-run `npm run report`. The connection persists from then on — you won't
   see the auth link again.

## Files

- `agent.ts` — Claude Agent SDK + Composio Tool Router → `data.json`
- `render.ts` — `data.json` → thumbnails in `./thumbs/` + `report.html`
- `data.json`, `thumbs/`, `report.html` — generated, safe to delete and re-run
