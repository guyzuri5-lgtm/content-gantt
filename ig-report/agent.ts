/**
 * agent.ts
 * ─────────
 * Pulls your Reels + private insights from Instagram into ./data.json.
 *
 * The fetching itself lives in ../api/_lib/instagram.js — the same module the
 * board's /api/ig-refresh endpoint runs — so this script and the button in the
 * app can't drift apart. What stays here is the part a server can't do: the
 * one-time interactive Instagram authorization.
 *
 * Run:  npm run agent   (or:  npx tsx agent.ts)
 * Custom window:  WINDOW_DAYS=90 npm run agent   (also: FETCH_LIMIT)
 *
 * First run: Composio won't have an Instagram connection yet. This script
 * detects that, prints an authorization link, and exits. Open the link, log
 * into Instagram, approve access, then re-run — the connection persists, and
 * from then on the board's own button works too.
 */

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Composio } from "@composio/core";
import {
  getInstagramConnection,
  listReelsInWindow,
  attachInsights,
  inlineThumbs,
  mergePosts,
} from "../api/_lib/instagram.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "data.json");

const COMPOSIO_USER_ID = process.env.COMPOSIO_USER_ID || "ig-report-user";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS) || 14;
const FETCH_LIMIT = Number(process.env.FETCH_LIMIT) || 25;

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

/** Prints the Instagram authorization link and exits — this is the one step that needs a human. */
async function printAuthLink(): Promise<never> {
  const composio = new Composio({ apiKey });
  console.log("Instagram isn't connected to this Composio account yet.");
  console.log("Requesting an authorization link…\n");

  const session = await composio.create(COMPOSIO_USER_ID, {
    toolkits: ["instagram"],
    manageConnections: true,
  });
  const req = await session.authorize("instagram");

  console.log("─".repeat(64));
  console.log("👉 Open this link, log into Instagram, and approve access:");
  console.log(`\n  ${req.redirectUrl}\n`);
  console.log("Then re-run:  npm run agent");
  console.log("The connection persists after that — for this script and for the");
  console.log("board's own “analyze new reels” button.");
  console.log("─".repeat(64));
  process.exit(0);
}

async function readExisting(): Promise<{ posts: any[] }> {
  try {
    const parsed = JSON.parse(await readFile(DATA_PATH, "utf8"));
    return Array.isArray(parsed?.posts) ? parsed : { posts: [] };
  } catch {
    return { posts: [] };
  }
}

async function main() {
  const connection = await getInstagramConnection(apiKey!, COMPOSIO_USER_ID);
  if (!connection.connected) await printAuthLink();
  console.log("✔ Instagram is connected.\n");

  const log = (line: string) => console.log(`  · ${line}`);

  console.log(`Listing your last ${WINDOW_DAYS} days of media…`);
  const { reels } = await listReelsInWindow(apiKey!, COMPOSIO_USER_ID, {
    windowDays: WINDOW_DAYS,
    fetchLimit: FETCH_LIMIT,
    log,
  });
  console.log(`\nFound ${reels.length} reel${reels.length === 1 ? "" : "s"} in the window.`);
  if (reels.length === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  console.log("\nReading insights…");
  await attachInsights(apiKey!, COMPOSIO_USER_ID, reels, { log });

  console.log("\nInlining thumbnails…");
  await inlineThumbs(reels, { log });

  const existing = await readExisting();
  const { posts, added, updated } = mergePosts(existing.posts, reels);

  await writeFile(
    DATA_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), windowDays: WINDOW_DAYS, posts }, null, 2),
    "utf8",
  );

  console.log(
    `\n✔ ${added} new, ${updated} updated, ${posts.length} total → ${path.relative(process.cwd(), DATA_PATH)}`,
  );
  console.log("Next: npm run render\n");
}

main().catch((err) => {
  const detail = err && typeof err === "object" && "detail" in err ? `\n\n${JSON.stringify(err.detail, null, 2).slice(0, 1500)}` : "";
  fail((err instanceof Error ? (err.stack ?? err.message) : String(err)) + detail);
});
