/**
 * POST /api/ig-refresh — "analyze the reels that aren't in the board yet".
 * ────────────────────────────────────────────────────────────────────────
 * The board is a static page, so it can't hold the Composio key. This is the
 * only server-side piece: it pulls from Instagram and writes the result into
 * the shared `shared_ig_imports` row the board reads.
 *
 * The board has no accounts by design — anyone with the link can use it — so
 * this endpoint has no user to authenticate. What guards it instead is only
 * friction: it refuses requests that didn't come from this site, and it won't
 * run more than once a minute. Neither is real security (an Origin header is
 * trivially forged, and the rate limit is per warm instance), but together
 * they stop a stray crawler or a stuck retry loop from burning the Composio
 * quota. If this ever needs to be genuinely protected, it needs an account.
 *
 * Env: COMPOSIO_API_KEY (required). SUPABASE_URL / SUPABASE_ANON_KEY,
 * COMPOSIO_USER_ID and BOARD_ID fall back to what the board itself ships with.
 */

import {
  IgError,
  listInstagramTools,
  describeTools,
  peekMedia,
  getInstagramConnection,
  listReelsInWindow,
  attachInsights,
  mergePosts,
} from "./_lib/instagram.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://gtgrgmslwunbtmfilnog.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || "sb_publishable_8_eHpmDoOVUtwHZLc_QGsw_nfWOUlVP";
const COMPOSIO_USER_ID = process.env.COMPOSIO_USER_ID || "ig-report-user";
const IG_TABLE = "shared_ig_imports";
const BOARD_ID = process.env.BOARD_ID || "main";
const MIN_SECONDS_BETWEEN_RUNS = 60;

const MAX_WINDOW_DAYS = 365;
const MAX_FETCH_LIMIT = 50;

function send(res, status, payload) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.status(status).send(JSON.stringify(payload));
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Only requests that came from this deployment's own page get through. Forgeable
 * by anyone who wants to — this is about stray traffic, not about attackers.
 */
function sameSite(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return true; // can't tell — don't lock the owner out
  const source = req.headers.origin || req.headers.referer;
  if (!source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

// Per warm instance only; Vercel may run several, so treat it as a speed bump.
let lastRunAt = 0;

async function readStored() {
  const url = `${SUPABASE_URL}/rest/v1/${IG_TABLE}?id=eq.${encodeURIComponent(BOARD_ID)}&select=data`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`reading ${IG_TABLE} failed (HTTP ${res.status}): ${await res.text()}`);
  const rows = await res.json();
  const data = Array.isArray(rows) && rows[0] ? rows[0].data : null;
  return data && Array.isArray(data.posts) ? data : { posts: [] };
}

async function writeStored(payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${IG_TABLE}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ id: BOARD_ID, data: payload, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`writing ${IG_TABLE} failed (HTTP ${res.status}): ${await res.text()}`);
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return send(res, 405, { error: "POST בלבד." });

  const apiKey = (process.env.COMPOSIO_API_KEY || "").trim();
  if (!apiKey) {
    return send(res, 500, {
      error: "COMPOSIO_API_KEY לא מוגדר בשרת.",
      hint: "Vercel → Project Settings → Environment Variables → COMPOSIO_API_KEY, ואז deploy מחדש.",
    });
  }

  if (!sameSite(req)) {
    return send(res, 403, { error: "הבקשה לא הגיעה מהלוח." });
  }

  const body = await readBody(req);

  // אבחון: לא עולה כלום ולא נוגע בנתונים, ולכן פטור ממגבלת הקצב
  if (body.debug === "raw") {
    try {
      const raw = await peekMedia(apiKey, COMPOSIO_USER_ID, 3);
      return send(res, 200, { ok: true, raw });
    } catch (e) {
      return send(res, 502, { error: e?.message, detail: e?.detail ? JSON.stringify(e.detail).slice(0, 1500) : undefined });
    }
  }

  if (body.debug === "schema") {
    try {
      const slugs = Array.isArray(body.slugs) && body.slugs.length
        ? body.slugs
        : ["INSTAGRAM_GET_USER_MEDIA", "INSTAGRAM_GET_POST_INSIGHTS"];
      return send(res, 200, { ok: true, schemas: await describeTools(apiKey, slugs) });
    } catch (e) {
      return send(res, 502, { error: e?.message });
    }
  }

  if (body.debug === "tools") {
    try {
      const listed = await listInstagramTools(apiKey);
      return send(res, 200, { ok: true, ...listed });
    } catch (e) {
      return send(res, 502, { error: e?.message, detail: e?.detail ? JSON.stringify(e.detail).slice(0, 1200) : undefined });
    }
  }

  const sinceLastRun = (Date.now() - lastRunAt) / 1000;
  if (sinceLastRun < MIN_SECONDS_BETWEEN_RUNS) {
    return send(res, 429, {
      error: "שליפה רצה ממש עכשיו. נסו שוב בעוד " + Math.ceil(MIN_SECONDS_BETWEEN_RUNS - sinceLastRun) + " שניות.",
    });
  }
  lastRunAt = Date.now();

  const windowDays = clamp(body.windowDays, 30, 1, MAX_WINDOW_DAYS);
  const fetchLimit = clamp(body.fetchLimit, 25, 1, MAX_FETCH_LIMIT);
  const refreshDays = clamp(body.refreshDays, 14, 0, MAX_WINDOW_DAYS);
  const mode = body.mode === "full" ? "full" : "incremental";

  const log = [];
  const note = (m) => log.push(m);

  try {
    const connection = await getInstagramConnection(apiKey, COMPOSIO_USER_ID);
    if (!connection.connected) {
      return send(res, 409, {
        error: "אינסטגרם לא מחוברת ל-Composio.",
        hint: "חיבור ראשוני הוא אישור OAuth ידני: הריצו פעם אחת `cd ig-report && npm run agent` ואשרו את הקישור שיודפס. אחרי זה החיבור נשמר והכפתור הזה יעבוד.",
      });
    }

    const stored = await readStored();
    const storedById = new Map(stored.posts.map((p) => [p.id, p]));
    note(`בענן כרגע: ${stored.posts.length} רילז`);

    const { reels } = await listReelsInWindow(apiKey, COMPOSIO_USER_ID, {
      windowDays,
      fetchLimit,
      log: note,
    });
    note(`נמצאו ${reels.length} רילז בחלון של ${windowDays} ימים`);

    // Incremental: everything new, plus anything recent enough that its numbers
    // are probably still moving. Reels older than that are already settled.
    const refreshCutoff = Date.now() - refreshDays * 24 * 60 * 60 * 1000;
    const targets =
      mode === "full"
        ? reels
        : reels.filter((r) => {
            if (!storedById.has(r.id)) return true;
            return new Date(r.timestamp).getTime() >= refreshCutoff;
          });

    const newOnes = targets.filter((r) => !storedById.has(r.id)).length;
    note(`נשלפות תובנות ל-${targets.length} רילז (${newOnes} חדשים)`);

    if (targets.length === 0) {
      return send(res, 200, {
        ok: true,
        added: 0,
        updated: 0,
        total: stored.posts.length,
        message: "אין רילז חדשים לנתח.",
        log,
      });
    }

    await attachInsights(apiKey, COMPOSIO_USER_ID, targets, { concurrency: 4 });

    // התמונות לא מוטמעות: thumbnail_url של אינסטגרם הוא פריים ברזולוציה מלאה,
    // ~190KB לריל, ושורה אחת עם כולם הגיעה ל-6.5MB והפילה את הכתיבה בטיימאאוט.
    // במקום זה נשמר הקישור, והוא מתרענן לכל ריל בחלון בכל ריצה — בחינם, כי
    // הוא ממילא חוזר ברשימת המדיה. ריל שיצא מהחלון יאבד בסוף את התמונה, וזה
    // המחיר הנכון מול לוח שלא מצליח להישמר.
    //
    // ממוזגים את כל הרילז שנמצאו ולא רק את אלה שנשלפו להם תובנות, כדי שגם
    // הוותיקים יקבלו קישור תמונה טרי. mergePosts מתעלם מערכים ריקים, ולכן
    // המדדים השמורים שלהם לא נדרסים.
    const { posts, added, updated } = mergePosts(stored.posts, reels);

    // ניקוי חד־פעמי של ההטמעות הענקיות שכבר נכתבו. תמונות קטנות מהייבוא
    // המקורי (~22KB) נשארות — הקישורים שלהן פגו מזמן ואין להן תחליף.
    const MAX_INLINE_THUMB = 40 * 1024;
    let dropped = 0;
    for (const post of posts) {
      if (typeof post.thumb === "string" && post.thumb.length > MAX_INLINE_THUMB) {
        delete post.thumb;
        dropped++;
      }
    }
    if (dropped) note(`הוסרו ${dropped} תמונות מוטמעות גדולות מדי`);

    const payload = {
      generatedAt: new Date().toISOString(),
      windowDays: Math.max(windowDays, stored.windowDays || 0),
      posts,
    };
    note(`גודל המטען: ${Math.round(JSON.stringify(payload).length / 1024)}KB`);
    await writeStored(payload);

    return send(res, 200, { ok: true, added, updated, total: posts.length, generatedAt: payload.generatedAt, log });
  } catch (e) {
    const detail = e instanceof IgError ? e.detail : null;
    return send(res, 502, {
      error: e?.message || "השליפה נכשלה.",
      detail: detail ? JSON.stringify(detail).slice(0, 1200) : undefined,
      log,
    });
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Vercel usually parses a JSON body for us, but not on every runtime and not
 * when the content-type is off — so fall back to reading the stream instead of
 * silently treating every setting as its default.
 */
async function readBody(req) {
  if (typeof req.body === "string") return safeJson(req.body);
  if (Buffer.isBuffer(req.body)) return safeJson(req.body.toString("utf8"));
  if (req.body && typeof req.body === "object") return req.body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    return safeJson(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
