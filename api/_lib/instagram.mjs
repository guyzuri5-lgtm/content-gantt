/**
 * instagram.js — the one place that knows how to pull Reels out of Instagram.
 * ──────────────────────────────────────────────────────────────────────────
 * Talks to Composio's REST API directly (no LLM, no Agent SDK): listing media
 * and reading insights is a mechanical pipeline, so a model in the loop only
 * added latency, cost and a second thing that could fail.
 *
 * Zero dependencies, plain ESM — it runs as-is in a Vercel function and under
 * `tsx` in ig-report/, which is what keeps the two sides from drifting apart.
 *
 * Every function returns the canonical post shape used everywhere downstream
 * (Supabase `ig_imports`, the board, the analysis screen):
 *
 *   { id, timestamp, date, mediaType, caption, permalink, thumbUrl, thumb,
 *     durationS, reach, views, likes, comments, shares, saved,
 *     totalInteractions, watchTimeS }
 */

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";

export const METRICS = [
  "reach",
  "views",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "ig_reels_avg_watch_time",
];

const MEDIA_FIELDS =
  "id,caption,permalink,thumbnail_url,media_url,timestamp,media_type,media_product_type";

/** Reels only. Instagram reports these two for video posts. */
const VIDEO_TYPES = new Set(["REELS", "VIDEO"]);

/** Composio returns { data, error, successful }; anything else is a surprise worth reporting verbatim. */
export class IgError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "IgError";
    this.detail = detail;
  }
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The exact nesting Composio wraps a tool response in has changed across
 * versions, so instead of hard-coding a path we walk the object for the first
 * array whose members look like the thing we asked for. Breadth-first, so the
 * shallowest (and therefore most likely) match wins.
 */
function findArray(root, looksRight, maxDepth = 6) {
  const queue = [[root, 0]];
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== "object" || depth > maxDepth) continue;
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((x) => x && typeof x === "object") && looksRight(node)) return node;
      for (const child of node) queue.push([child, depth + 1]);
      continue;
    }
    for (const key of Object.keys(node)) queue.push([node[key], depth + 1]);
  }
  return null;
}

function findValue(root, key, maxDepth = 6) {
  const queue = [[root, 0]];
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== "object" || depth > maxDepth) continue;
    if (!Array.isArray(node) && node[key] !== undefined && node[key] !== null) return node[key];
    const children = Array.isArray(node) ? node : Object.keys(node).map((k) => node[k]);
    for (const child of children) queue.push([child, depth + 1]);
  }
  return null;
}

const looksLikeMedia = (arr) =>
  arr.some((x) => typeof x.id === "string" && (x.media_type || x.permalink || x.timestamp));

const looksLikeInsights = (arr) =>
  arr.some((x) => typeof x.name === "string" && (x.values !== undefined || x.total_value !== undefined));

// ── Composio plumbing ───────────────────────────────────────────────────────

async function composioFetch(apiKey, path, init = {}) {
  let res;
  try {
    res = await fetch(`${COMPOSIO_BASE}${path}`, {
      ...init,
      headers: { "x-api-key": apiKey, "content-type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    throw new IgError(`Composio is unreachable (${path}): ${e.message}`, null);
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new IgError(`Composio returned non-JSON on ${path} (HTTP ${res.status}).`, text.slice(0, 600));
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || body?.error || `HTTP ${res.status}`;
    throw new IgError(`Composio rejected ${path}: ${msg}`, body);
  }
  return body;
}

/** Runs one Composio tool and hands back its unwrapped payload. */
async function runTool(apiKey, slug, userId, args) {
  const body = await composioFetch(apiKey, `/tools/execute/${slug}`, {
    method: "POST",
    // בלי version מפורש Composio עלול לא לפתור את הכלי ולהחזיר "not found"
    body: JSON.stringify({ user_id: userId, arguments: args, version: "latest" }),
  });
  if (body && body.successful === false) {
    throw new IgError(`${slug} failed: ${body.error || "no reason given"}`, body.data ?? null);
  }
  return body?.data ?? body;
}

/**
 * Is Instagram actually connected for this Composio user? Connecting for the
 * first time is an interactive OAuth dance, so this only reports — the caller
 * decides how to ask the human to go do it.
 */
export async function getInstagramConnection(apiKey, composioUserId) {
  const params = new URLSearchParams({ toolkit_slugs: "instagram", user_ids: composioUserId, limit: "20" });
  const body = await composioFetch(apiKey, `/connected_accounts?${params}`);
  const items = body?.items || body?.data || [];
  const active = items.find((a) => String(a?.status || "").toUpperCase() === "ACTIVE");
  return { connected: !!active, account: active || null, all: items };
}

/**
 * Which Instagram tools does this project actually expose? Slugs drift between
 * Composio versions, and a wrong one fails as a flat 404 — so this asks instead
 * of trusting the docs.
 */
export async function listInstagramTools(apiKey) {
  const attempts = ["toolkit_slug=instagram&limit=200", "toolkit_slugs=instagram&limit=200", "limit=200&search=instagram"];
  for (const query of attempts) {
    let body;
    try {
      body = await composioFetch(apiKey, `/tools?${query}`);
    } catch {
      continue;
    }
    const items = body?.items || body?.data || [];
    const tools = items
      .map((t) => ({ slug: t.slug || t.name, version: t.version, deprecated: t.deprecated }))
      .filter((t) => typeof t.slug === "string" && t.slug.toUpperCase().startsWith("INSTAGRAM"));
    if (tools.length) return { query, count: items.length, tools };
  }
  return { query: null, count: 0, tools: [] };
}

// ── The pipeline ────────────────────────────────────────────────────────────

/**
 * One page of the user's media. Composio may or may not accept `fields` and
 * `after`; an argument it doesn't know is a hard error, so on the first
 * rejection we retry with the minimum and let Instagram's defaults decide.
 */
async function listMediaPage(apiKey, composioUserId, { limit, after }) {
  const full = { ig_user_id: "me", limit, fields: MEDIA_FIELDS };
  if (after) full.after = after;
  try {
    return await runTool(apiKey, "INSTAGRAM_GET_IG_USER_MEDIA", composioUserId, full);
  } catch (e) {
    if (!(e instanceof IgError)) throw e;
    const minimal = { ig_user_id: "me", limit };
    if (after) minimal.after = after;
    return await runTool(apiKey, "INSTAGRAM_GET_IG_USER_MEDIA", composioUserId, minimal);
  }
}

/**
 * Insights, degrading gracefully: Instagram rejects the whole call when one
 * metric doesn't apply to a given media, so each rejection drops the metric it
 * named and tries again. A metric we never got a number for stays null — it is
 * never guessed.
 */
async function fetchInsights(apiKey, composioUserId, mediaId) {
  let metrics = [...METRICS];
  const collected = {};

  for (let attempt = 0; attempt < METRICS.length && metrics.length > 0; attempt++) {
    try {
      const raw = await runTool(apiKey, "INSTAGRAM_GET_IG_MEDIA_INSIGHTS", composioUserId, {
        ig_media_id: mediaId,
        metric: metrics.join(","),
      });
      const rows = findArray(raw, looksLikeInsights) || [];
      for (const row of rows) {
        const value =
          toNum(row?.total_value?.value) ??
          toNum(Array.isArray(row?.values) ? row.values[0]?.value : null) ??
          toNum(row?.value);
        if (row?.name) collected[row.name] = value;
      }
      return collected;
    } catch (e) {
      const said = String(e?.message || "") + " " + JSON.stringify(e?.detail ?? "");
      const offending = metrics.filter((m) => said.includes(m));
      // Nothing identifiable to drop — one more blind attempt would just repeat.
      if (offending.length === 0 || offending.length === metrics.length) return collected;
      metrics = metrics.filter((m) => !offending.includes(m));
    }
  }
  return collected;
}

function normalizeMedia(raw) {
  const timestamp = raw.timestamp || raw.created_time || null;
  const when = timestamp ? new Date(timestamp) : null;
  const valid = when && !Number.isNaN(when.getTime());
  return {
    id: String(raw.id),
    timestamp: valid ? when.toISOString() : null,
    date: valid ? when.toISOString().slice(0, 10) : null,
    mediaType: raw.media_type || raw.media_product_type || null,
    caption: typeof raw.caption === "string" ? raw.caption : "",
    permalink: raw.permalink || null,
    thumbUrl: raw.thumbnail_url || raw.media_url || null,
    durationS: toNum(raw.duration ?? raw.video_duration ?? raw.duration_s),
  };
}

/**
 * Walks back through the user's media until it leaves the window, keeping only
 * video posts. Stops at `maxPages` so a misbehaving cursor can't spin forever.
 */
/** @param {{windowDays: number, fetchLimit: number, maxPages?: number, log?: (line: string) => void}} options */
export async function listReelsInWindow(apiKey, composioUserId, { windowDays, fetchLimit, maxPages = 5, log }) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const reels = [];
  const seen = new Set();
  const seenMedia = new Set();
  let after = null;
  let firstRaw = null;

  for (let page = 0; page < maxPages; page++) {
    const raw = await listMediaPage(apiKey, composioUserId, { limit: fetchLimit, after });
    if (page === 0) firstRaw = raw;

    const items = findArray(raw, looksLikeMedia);
    if (!items) {
      throw new IgError(
        "Couldn't find the media list in Instagram's response. The tool's output shape may have changed.",
        raw,
      );
    }

    let oldestOnPage = Infinity;
    let freshOnPage = 0;
    for (const item of items) {
      const post = normalizeMedia(item);
      if (!post.timestamp) continue;
      const t = new Date(post.timestamp).getTime();
      oldestOnPage = Math.min(oldestOnPage, t);
      if (!seenMedia.has(post.id)) {
        seenMedia.add(post.id);
        freshOnPage++;
      }
      if (t < cutoff) continue;
      if (!VIDEO_TYPES.has(String(post.mediaType || "").toUpperCase())) continue;
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      reels.push(post);
    }

    log?.(`page ${page + 1}: ${items.length} media, ${reels.length} reels in window so far`);

    // The page's oldest post is already outside the window → nothing older can qualify.
    if (oldestOnPage < cutoff || items.length === 0) break;

    const next = findValue(raw, "after");
    // A cursor that doesn't move, or a page that repeats what we already saw,
    // means paging isn't working — keep going and we'd just re-buy the same page.
    if (!next || next === after || freshOnPage === 0) break;
    after = next;
  }

  reels.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return { reels, firstRaw };
}

/**
 * Attaches the eight raw metrics to each post it is given.
 * @param {string} apiKey
 * @param {string} composioUserId
 * @param {any[]} posts
 * @param {{concurrency?: number, log?: (line: string) => void}} [options]
 */
export async function attachInsights(apiKey, composioUserId, posts, { concurrency = 4, log } = {}) {
  let done = 0;
  const queue = [...posts];

  async function worker() {
    for (;;) {
      const post = queue.shift();
      if (!post) return;
      const m = await fetchInsights(apiKey, composioUserId, post.id);
      post.reach = m.reach ?? null;
      post.views = m.views ?? null;
      post.likes = m.likes ?? null;
      post.comments = m.comments ?? null;
      post.shares = m.shares ?? null;
      post.saved = m.saved ?? null;
      post.totalInteractions = m.total_interactions ?? null;
      // Instagram reports average watch time in milliseconds; seconds is what a human reads.
      post.watchTimeS =
        m.ig_reels_avg_watch_time == null ? null : Math.round((m.ig_reels_avg_watch_time / 1000) * 10) / 10;
      log?.(`insights ${++done}/${posts.length}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, posts.length) }, worker));
  return posts;
}

/**
 * Instagram's thumbnail URLs are signed and expire within days, so the image
 * is inlined as a data URI once and stored with the post — otherwise every
 * reel older than a week would render as a broken box.
 */
/** @param {{maxBytes?: number}} [options] */
export async function inlineThumb(url, { maxBytes = 400 * 1024 } = {}) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    const type = res.headers.get("content-type") || "image/jpeg";
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/**
 * @param {any[]} posts
 * @param {{concurrency?: number, log?: (line: string) => void}} [options]
 */
export async function inlineThumbs(posts, { concurrency = 4, log } = {}) {
  const queue = [...posts];
  let done = 0;
  async function worker() {
    for (;;) {
      const post = queue.shift();
      if (!post) return;
      post.thumb = await inlineThumb(post.thumbUrl);
      log?.(`thumb ${++done}/${posts.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, posts.length) }, worker));
  return posts;
}

/**
 * Merges a fresh pull into what we already had.
 *
 * Additive on purpose: a post that exists only in the stored copy survives
 * (it may simply have aged out of the window), and a stored thumbnail is kept
 * when the new pull couldn't fetch one.
 */
export function mergePosts(existing, incoming) {
  const byId = new Map();
  for (const p of existing || []) if (p && p.id) byId.set(p.id, p);

  let added = 0;
  let updated = 0;

  for (const post of incoming) {
    const prev = byId.get(post.id);
    if (!prev) {
      byId.set(post.id, post);
      added++;
      continue;
    }
    const merged = { ...prev };
    for (const [key, value] of Object.entries(post)) {
      if (value === null || value === undefined) continue;
      merged[key] = value;
    }
    if (!merged.thumb && prev.thumb) merged.thumb = prev.thumb;
    if (JSON.stringify(merged) !== JSON.stringify(prev)) updated++;
    byId.set(post.id, merged);
  }

  const posts = [...byId.values()].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return { posts, added, updated };
}
