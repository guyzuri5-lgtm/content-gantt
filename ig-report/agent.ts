/**
 * agent.ts
 * ─────────
 * Connects to Instagram via Composio's hosted Tool Router (MCP), then uses
 * the Claude Agent SDK to pull the last 14 days of Reels + their private
 * insights. Writes the result to ./data.json for render.ts to pick up.
 *
 * Run:  npm run agent   (or:  npx tsx agent.ts)
 * Custom window:  WINDOW_DAYS=90 npm run agent   (also: FETCH_LIMIT, MAX_TURNS, MAX_BUDGET_USD)
 *
 * First run: Composio won't have an Instagram connection yet. This script
 * detects that, prints an authorization link, and exits. Open the link, log
 * into Instagram, approve access, then re-run the same command — the
 * connection persists after that.
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Composio } from "@composio/core";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "data.json");

/**
 * The Agent SDK bundles its own Claude Code binary by default, which doesn't
 * share this machine's logged-in `claude` CLI session and fails with
 * "Not logged in". If a global `claude` is on PATH (and therefore already
 * authenticated, since that's how this whole toolchain runs), point the SDK
 * at it instead. Falls back to the SDK's built-in binary if none is found.
 */
function findGlobalClaudeExecutable(): string | undefined {
  try {
    const result = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

const MODEL = "claude-sonnet-4-6";
const COMPOSIO_USER_ID = "ig-report-user";
// Overridable for ad-hoc windows, e.g.: WINDOW_DAYS=90 npm run agent
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS) || 14;
const FETCH_LIMIT = Number(process.env.FETCH_LIMIT) || 25;
const MAX_TURNS = Number(process.env.MAX_TURNS) || 60;
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD) || 2;
const METRICS =
  "reach,views,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const apiKey = process.env.COMPOSIO_API_KEY?.trim();
if (!apiKey || apiKey === "PASTE_YOUR_KEY_HERE") {
  fail(
    "COMPOSIO_API_KEY is missing or still the placeholder.\n" +
      "  Open .env in this folder and paste your Composio API key in place of\n" +
      "  PASTE_YOUR_KEY_HERE, then re-run: npm run agent",
  );
}

// The Agent SDK spawns its own Claude Code subprocess, which needs its own
// Anthropic credential — it does not inherit a locally logged-in `claude`
// CLI session. Fail fast with a clear message instead of the subprocess's
// cryptic "Not logged in · Please run /login".
const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)?.trim();
if (!anthropicKey || anthropicKey === "PASTE_YOUR_ANTHROPIC_KEY_HERE") {
  fail(
    "ANTHROPIC_API_KEY is missing or still the placeholder.\n" +
      "  Sign in to https://platform.claude.com -> Settings -> API keys -> Create key\n" +
      "  (see https://platform.claude.com/docs/en/get-api-key). Open .env in this\n" +
      "  folder and paste it in place of PASTE_YOUR_ANTHROPIC_KEY_HERE, then\n" +
      "  re-run: npm run agent",
  );
}

const composio = new Composio({ apiKey });

// ── Shape written to data.json — one entry per qualifying Reel ─────────────
type Post = {
  id: string;
  caption: string;
  permalink: string;
  thumbnail_url: string;
  timestamp: string;
  media_type: string;
  duration_s: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  total_interactions: number | null;
  ig_reels_avg_watch_time: number | null;
};

const POST_FIELDS = [
  "id",
  "caption",
  "permalink",
  "thumbnail_url",
  "timestamp",
  "media_type",
  "duration_s",
  "reach",
  "views",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "ig_reels_avg_watch_time",
] as const;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          caption: { type: "string" },
          permalink: { type: "string" },
          thumbnail_url: { type: "string" },
          timestamp: { type: "string" },
          media_type: { type: "string" },
          duration_s: { type: ["number", "null"] },
          reach: { type: ["number", "null"] },
          views: { type: ["number", "null"] },
          likes: { type: ["number", "null"] },
          comments: { type: ["number", "null"] },
          shares: { type: ["number", "null"] },
          saved: { type: ["number", "null"] },
          total_interactions: { type: ["number", "null"] },
          ig_reels_avg_watch_time: { type: ["number", "null"] },
        },
        required: [...POST_FIELDS],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

/** Checks whether Instagram is connected in this Composio session; if not, prints an auth link and exits. */
async function ensureInstagramConnected(
  session: Awaited<ReturnType<typeof composio.create>>,
): Promise<void> {
  const { items } = await session.toolkits({ toolkits: ["instagram"] });
  const ig = items.find((t) => t.slug === "instagram");

  if (ig?.connection?.isActive) {
    console.log("✔ Instagram is connected.\n");
    return;
  }

  console.log("Instagram isn't connected to this Composio account yet.");
  console.log("Requesting an authorization link…\n");
  const req = await session.authorize("instagram");

  console.log("─".repeat(64));
  console.log("👉 Open this link, log into Instagram, and approve access:");
  console.log(`\n  ${req.redirectUrl}\n`);
  console.log("Then re-run:  npm run agent");
  console.log("The connection persists after that — no need to do this again.");
  console.log("─".repeat(64));
  process.exit(0);
}

async function main() {
  console.log(`Creating a Composio Tool Router session for "${COMPOSIO_USER_ID}"…`);
  const session = await composio.create(COMPOSIO_USER_ID, {
    toolkits: ["instagram"],
    manageConnections: true,
    mcp: true,
  });

  await ensureInstagramConnected(session);
  console.log(`MCP session ready → ${session.mcp.url}\n`);

  const today = new Date();
  const windowStart = new Date(today.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const systemPrompt = `You are a data-collection agent. Your only tool source is an MCP server
named "instagram" exposing Instagram Graph API tools. Follow this pipeline
exactly, then stop — no narration, no summary, no tool other than the ones
needed for the steps below.

Today's date is ${today.toISOString().slice(0, 10)}. The ${WINDOW_DAYS}-day window starts
${windowStart.toISOString().slice(0, 10)} (inclusive) and runs through today.

1. Call INSTAGRAM_GET_IG_USER_MEDIA with ig_user_id="me" and limit=${FETCH_LIMIT}.
   - Posts come back newest-first. If the oldest post in a page is still
     inside the ${WINDOW_DAYS}-day window (meaning older qualifying posts may
     exist beyond this page), paginate for more using whatever cursor/paging
     mechanism the tool exposes (e.g. an "after" field in the response), and
     keep going until either a page's oldest post falls before the window
     start, or the API reports no more pages. Don't paginate past that point.
2. Keep only posts where media_type is "REELS" or "VIDEO" AND whose
   timestamp falls inside the ${WINDOW_DAYS}-day window above. Discard
   everything else (images, carousels, older posts).
3. For each remaining post, call INSTAGRAM_GET_IG_MEDIA_INSIGHTS with
   ig_media_id set to that post's id and metric="${METRICS}".
   - If the call errors because one or more metrics are unsupported for
     that media, retry the SAME call with just the offending metric(s)
     removed. Repeat until it succeeds or you're down to one metric. Any
     metric you never obtained a value for is null in your final output —
     never invent a number.
4. For each post, look for a total video length in seconds anywhere in the
   media object or insights response (fields like "duration",
   "video_duration", or similar). If nothing supplies one, use null — do
   not estimate or guess.
5. Once every post is processed, return your final answer as the structured
   JSON output matching the provided schema: one entry per post with id,
   caption (first 80 characters, hard-truncated — not summarized),
   permalink, thumbnail_url (fall back to media_url if thumbnail_url is
   absent), timestamp, media_type, duration_s, and the eight raw metric
   values (reach, views, likes, comments, shares, saved, total_interactions,
   ig_reels_avg_watch_time).

If there are zero qualifying posts, return {"posts": []} — do not error out.`;

  console.log("Asking Claude to pull your Reels + insights (this can take a minute)…\n");

  let finalPosts: Post[] | null = null;
  let sawError: string | null = null;

  for await (const message of query({
    prompt: `Fetch my last ${WINDOW_DAYS} days of Instagram Reels with insights now, following the pipeline exactly. Return only the structured result.`,
    options: {
      model: MODEL,
      systemPrompt,
      mcpServers: {
        instagram: {
          type: "http",
          url: session.mcp.url,
          headers: session.mcp.headers,
          alwaysLoad: true,
        },
      },
      tools: [], // no built-in tools — only the Instagram MCP server is available
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
      maxTurns: MAX_TURNS,
      maxBudgetUsd: MAX_BUDGET_USD,
      pathToClaudeCodeExecutable: findGlobalClaudeExecutable(),
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      const ig = message.mcp_servers.find((s) => s.name === "instagram");
      console.log(`  MCP server "instagram": ${ig?.status ?? "unknown"} · model ${message.model}`);
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          console.log(`  → ${block.name}(${JSON.stringify(block.input)})`);
        } else if (block.type === "text" && block.text.trim()) {
          console.log(`  · ${block.text.trim()}`);
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        const structured = message.structured_output as { posts?: Post[] } | undefined;
        finalPosts = structured?.posts ?? [];
        console.log(
          `\n✔ Done in ${(message.duration_ms / 1000).toFixed(1)}s · est. $${message.total_cost_usd.toFixed(3)}`,
        );
      } else {
        const detail = "errors" in message && message.errors?.length ? `: ${message.errors.join("; ")}` : "";
        sawError = `${message.subtype}${detail}`;
      }
    }
  }

  if (sawError) {
    fail(`Claude Agent SDK run did not finish cleanly (${sawError}).`);
  }
  if (!finalPosts) {
    fail("No structured output was returned. Try re-running.");
  }

  // Belt-and-suspenders: hard-truncate captions and drop anything malformed.
  const posts = finalPosts
    .filter((p) => p && typeof p.id === "string" && p.id.length > 0)
    .map((p) => ({ ...p, caption: (p.caption ?? "").slice(0, 80) }));

  const payload = {
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    composio_user_id: COMPOSIO_USER_ID,
    posts,
  };

  await writeFile(DATA_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `\nSaved ${posts.length} reel${posts.length === 1 ? "" : "s"} → ${path.relative(process.cwd(), DATA_PATH)}`,
  );
  console.log("Next: npm run render\n");
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
