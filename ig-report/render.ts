/**
 * render.ts
 * ─────────
 * Reads ./data.json (written by agent.ts), computes the analytics, downloads
 * each Reel's thumbnail via curl, and writes a single self-contained
 * ./report.html you can open directly in a browser.
 *
 * Run:  npm run render   (or:  npx tsx render.ts)
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "data.json");
const THUMBS_DIR = path.join(__dirname, "thumbs");
const REPORT_PATH = path.join(__dirname, "report.html");

const STRONG_HOOK_S = 12; // "strong-hook count (watch ≥ 12s)"
const REPLAY_WINNER_RATE = 1.2; // "replay-winner count (hook ≥ 1.2)" → replay_rate ≥ 1.2

// ── Input shape (mirrors agent.ts's Post) ───────────────────────────────────
type RawPost = {
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

type DataFile = {
  generated_at: string;
  window_days: number;
  composio_user_id: string;
  posts: RawPost[];
};

// ── Post + every derived metric, ready for rendering ────────────────────────
type Post = RawPost & {
  watch_s: number | null;
  hook_rate: number | null;
  replay_rate: number | null;
  share_pct: number | null;
  save_pct: number | null;
  hook_score: number | null;
  hookAxis: number | null; // 0–100, normalized watch_s
  reachAxis: number | null; // 0–100, normalized reach
  viralAxis: number | null; // 0–100, normalized shares+saves
  diagnosis: Diagnosis;
  thumbDataUri: string | null;
};

type Diagnosis = {
  label: string;
  tone: "green" | "amber" | "red" | "neutral";
  isPackagingMismatch: boolean;
};

// ── Small math helpers ───────────────────────────────────────────────────────
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function normalize(values: (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min;
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    if (range === 0) return 100; // everyone tied → full bars, not an arbitrary 0
    return ((v - min) / range) * 100;
  });
}

function safeDiv(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return a / b;
}

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Thumbnail download (curl) → base64 data URI ─────────────────────────────
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const PLACEHOLDER_THUMB =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#e6e6ec"/><text x="100" y="105" font-family="sans-serif" font-size="14" fill="#9090a0" text-anchor="middle">no thumbnail</text></svg>`,
  ).toString("base64");

async function downloadThumb(post: RawPost): Promise<string | null> {
  if (!post.thumbnail_url) return null;
  const outPath = path.join(THUMBS_DIR, `${post.id}.jpg`);

  if (!(await fileExists(outPath))) {
    try {
      await execFileAsync("curl", ["-sL", "--fail", "--max-time", "20", "-o", outPath, post.thumbnail_url]);
    } catch {
      return null; // download failed — caller falls back to a placeholder
    }
  }

  try {
    const bytes = await readFile(outPath);
    if (bytes.length === 0) return null;
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── Diagnosis tag ────────────────────────────────────────────────────────────
function diagnose(hookAxis: number | null, reachAxis: number | null, viralAxis: number | null): Diagnosis {
  if (hookAxis == null || reachAxis == null || viralAxis == null) {
    return { label: "Underperformed", tone: "neutral", isPackagingMismatch: false };
  }
  const hookHigh = hookAxis >= 50;
  const reachHigh = reachAxis >= 50;
  const viralHigh = viralAxis >= 50;

  if (hookHigh && reachHigh && viralHigh) {
    return { label: "Winner — all three axes worked", tone: "green", isPackagingMismatch: false };
  }
  if (!hookHigh && !reachHigh && !viralHigh) {
    return { label: "Weak on all axes — kill this format", tone: "red", isPackagingMismatch: false };
  }
  if (hookHigh && !reachHigh) {
    return { label: "Strong hook, IG didn't push it", tone: "amber", isPackagingMismatch: true };
  }
  if (!hookHigh && reachHigh) {
    return { label: "People clicked, content didn't hold", tone: "amber", isPackagingMismatch: true };
  }
  if (!hookHigh && viralHigh) {
    return { label: "Sharable concept, weak delivery", tone: "amber", isPackagingMismatch: true };
  }
  if (hookHigh && reachHigh && !viralHigh) {
    return { label: "Hook landed", tone: "green", isPackagingMismatch: false };
  }
  return { label: "Underperformed", tone: "neutral", isPackagingMismatch: false };
}

// ── Caption word-pattern callout ─────────────────────────────────────────────
const STOPWORDS = new Set(
  `the a an and or but in on at to of for is it this that with my your you i we our are was were be been just so if as from by when how what who out up new one all not can will get got like more most really very也就是`
    .split(/\s+/)
    .filter(Boolean),
);

function tokenizeCaption(caption: string): Set<string> {
  const words = caption
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]/g, " ")
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

function patternWords(top: Post[], bottom: Post[]): { winners: string[]; flops: string[] } {
  const topSets = top.map((p) => tokenizeCaption(p.caption));
  const bottomSets = bottom.map((p) => tokenizeCaption(p.caption));

  const docFreq = (sets: Set<string>[], word: string) => sets.filter((s) => s.has(word)).length;

  const topVocab = new Set(topSets.flatMap((s) => [...s]));
  const bottomVocab = new Set(bottomSets.flatMap((s) => [...s]));

  const winners = [...topVocab]
    .filter((w) => docFreq(topSets, w) >= 2 && docFreq(bottomSets, w) === 0)
    .sort((a, b) => docFreq(topSets, b) - docFreq(topSets, a));

  const flops = [...bottomVocab]
    .filter((w) => docFreq(bottomSets, w) >= 2 && docFreq(topSets, w) === 0)
    .sort((a, b) => docFreq(bottomSets, b) - docFreq(bottomSets, a));

  return { winners, flops };
}

// ── HTML building blocks ─────────────────────────────────────────────────────
function axisBar(label: string, value: number | null): string {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const display = value == null ? "—" : `${Math.round(value)}`;
  const empty = value == null ? " axis-empty" : "";
  return `
    <div class="axis-row${empty}">
      <span class="axis-label">${label}</span>
      <div class="axis-track"><div class="axis-fill axis-${label.toLowerCase()}" style="width:${pct}%"></div></div>
      <span class="axis-value">${display}</span>
    </div>`;
}

function postCard(post: Post, rank: number, borderClass: string): string {
  const thumb = post.thumbDataUri ?? PLACEHOLDER_THUMB;
  const caption = escapeHtml(post.caption || "(no caption)");
  return `
    <article class="card ${borderClass}">
      <a class="thumb-link" href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener noreferrer">
        <img class="thumb" src="${thumb}" alt="Reel thumbnail" loading="lazy" width="96" height="96" />
      </a>
      <div class="card-body">
        <div class="card-top">
          <span class="rank">#${rank}</span>
          <span class="tag tag-${post.diagnosis.tone}">${escapeHtml(post.diagnosis.label)}</span>
        </div>
        <p class="caption">${caption}</p>
        <div class="axes">
          ${axisBar("Hook", post.hookAxis)}
          ${axisBar("Reach", post.reachAxis)}
          ${axisBar("Viral", post.viralAxis)}
        </div>
      </div>
      <div class="card-right">
        <div class="hook-score">${post.hook_score == null ? "—" : fmtNum(post.hook_score, 0)}</div>
        <div class="hook-score-label">hook score</div>
        <a class="open-link" href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener noreferrer">open ↗</a>
      </div>
    </article>`;
}

function miniCard(post: Post): string {
  const thumb = post.thumbDataUri ?? PLACEHOLDER_THUMB;
  return `
    <a class="mini-card" href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener noreferrer">
      <img class="mini-thumb" src="${thumb}" alt="Reel thumbnail" loading="lazy" width="64" height="64" />
      <div class="mini-body">
        <p class="mini-caption">${escapeHtml(post.caption || "(no caption)")}</p>
        <span class="mini-score">${post.hook_score == null ? "—" : fmtNum(post.hook_score, 0)} pts</span>
      </div>
    </a>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let raw: DataFile;
  try {
    raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch {
    console.error(`\n✖ Couldn't read ${path.relative(process.cwd(), DATA_PATH)}.`);
    console.error("  Run the agent first: npm run agent\n");
    process.exit(1);
  }

  if (!raw.posts || raw.posts.length === 0) {
    console.error("\n✖ data.json has zero posts — nothing to report.");
    console.error("  (Either you have no Reels in the last 14 days, or agent.ts hasn't run yet.)\n");
    process.exit(1);
  }

  await mkdir(THUMBS_DIR, { recursive: true });

  console.log(`Downloading ${raw.posts.length} thumbnail(s)…`);
  const thumbs = await Promise.all(raw.posts.map((p) => downloadThumb(p)));

  // ── Derived per-post metrics ────────────────────────────────────────────
  const withMetrics = raw.posts.map((p, i) => {
    const watch_s = p.ig_reels_avg_watch_time != null ? p.ig_reels_avg_watch_time / 1000 : null;
    const hook_rate = safeDiv(watch_s, p.duration_s);
    const replay_rate = safeDiv(p.views, p.reach);
    const share_pct = p.reach ? ((p.shares ?? 0) / p.reach) * 100 : null;
    const save_pct = p.reach ? ((p.saved ?? 0) / p.reach) * 100 : null;
    const hook_score =
      watch_s != null && p.reach != null && p.reach >= 0
        ? watch_s * Math.sqrt(p.reach) * (1 + (share_pct ?? 0) / 100 + (save_pct ?? 0) / 200)
        : null;

    return {
      ...p,
      watch_s,
      hook_rate,
      replay_rate,
      share_pct,
      save_pct,
      hook_score,
      thumbDataUri: thumbs[i],
    };
  });

  // ── Normalized 0–100 axes, shared across every post ─────────────────────
  const hookAxes = normalize(withMetrics.map((p) => p.watch_s));
  const reachAxes = normalize(withMetrics.map((p) => p.reach));
  const viralAxes = normalize(withMetrics.map((p) => (p.shares ?? 0) + (p.saved ?? 0)));

  const posts: Post[] = withMetrics.map((p, i) => ({
    ...p,
    hookAxis: hookAxes[i],
    reachAxis: reachAxes[i],
    viralAxis: viralAxes[i],
    diagnosis: diagnose(hookAxes[i], reachAxes[i], viralAxes[i]),
  }));

  // ── Ranking (by hook_score desc; missing scores sink to the bottom) ─────
  const ranked = [...posts].sort((a, b) => {
    if (a.hook_score == null && b.hook_score == null) return (b.reach ?? 0) - (a.reach ?? 0);
    if (a.hook_score == null) return 1;
    if (b.hook_score == null) return -1;
    return b.hook_score - a.hook_score;
  });
  const scored = ranked.filter((p) => p.hook_score != null);

  const top3 = scored.slice(0, 3);
  const bottom3 = scored.length > 3 ? scored.slice(-3).reverse() : [];
  const top3Ids = new Set(top3.map((p) => p.id));
  const bottom3Ids = new Set(bottom3.map((p) => p.id));

  // ── 🟡 Fix: hook_rate top quartile, watch_s bottom quartile ─────────────
  const hookRates = posts.map((p) => p.hook_rate).filter((v): v is number => v != null);
  const watchTimes = posts.map((p) => p.watch_s).filter((v): v is number => v != null);
  const hookRateP75 = hookRates.length ? percentile(hookRates, 75) : NaN;
  const watchSP25 = watchTimes.length ? percentile(watchTimes, 25) : NaN;
  const fixCandidates = posts
    .filter((p) => p.hook_rate != null && p.watch_s != null)
    .filter((p) => p.hook_rate! >= hookRateP75 && p.watch_s! <= watchSP25)
    .sort((a, b) => b.hook_rate! - a.hook_rate!)
    .slice(0, 3);

  // ── Headline insight: top reel's reach ÷ median reach ────────────────────
  const allReach = posts.map((p) => p.reach).filter((v): v is number => v != null);
  const medianReach = allReach.length ? median(allReach) : NaN;
  const topReel = scored[0] ?? ranked[0];
  const headlineMultiple =
    topReel?.reach != null && Number.isFinite(medianReach) && medianReach > 0 ? topReel.reach / medianReach : null;

  // ── Pattern callout ──────────────────────────────────────────────────────
  const patternN = Math.min(5, Math.floor(scored.length / 2));
  const { winners, flops } =
    patternN >= 2 ? patternWords(scored.slice(0, patternN), scored.slice(-patternN)) : { winners: [], flops: [] };

  // ── Quick stats ───────────────────────────────────────────────────────────
  const totalReach = allReach.reduce((a, b) => a + b, 0);
  const reachConcentration =
    topReel?.reach != null && totalReach > 0 ? (topReel.reach / totalReach) * 100 : null;
  const watchTimeGap = watchTimes.length ? Math.max(...watchTimes) - Math.min(...watchTimes) : null;
  const strongHookCount = posts.filter((p) => p.watch_s != null && p.watch_s >= STRONG_HOOK_S).length;
  const replayWinnerCount = posts.filter(
    (p) => p.replay_rate != null && p.replay_rate >= REPLAY_WINNER_RATE,
  ).length;

  // ── Render ────────────────────────────────────────────────────────────────
  const windowLabel = `Last ${raw.window_days} days · generated ${new Date(raw.generated_at).toLocaleString(
    "en-US",
    { dateStyle: "medium", timeStyle: "short" },
  )}`;

  const html = `<title>Instagram Reels Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: light;
    --bg: #f7f7fb;
    --card: #ffffff;
    --ink: #16161d;
    --ink-soft: #55555f;
    --ink-faint: #8b8b96;
    --border: #e6e6ee;
    --green: #1a9e5c;
    --green-bg: #e7f7ee;
    --red: #d43d3d;
    --red-bg: #fdeaea;
    --amber: #b8790a;
    --amber-bg: #fdf1dc;
    --neutral: #6b6b78;
    --neutral-bg: #eeeef3;
    --accent: #5b4fe0;
    --radius: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    padding: 32px 16px 80px;
  }
  .wrap { max-width: 920px; margin: 0 auto; }
  header.page-head { margin-bottom: 28px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .subtitle { color: var(--ink-faint); font-size: 14px; }

  section { margin-bottom: 28px; }
  .card-shell {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px 24px;
  }

  .headline { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .headline .big { font-size: 40px; font-weight: 700; color: var(--accent); line-height: 1; }
  .headline .text { font-size: 15px; color: var(--ink-soft); max-width: 46ch; }

  .pattern-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 620px) { .pattern-grid { grid-template-columns: 1fr; } }
  .pattern-col h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); }
  .word-pill {
    display: inline-block; margin: 0 6px 6px 0; padding: 4px 10px;
    border-radius: 999px; font-size: 13px; font-weight: 600;
  }
  .word-pill.win { background: var(--green-bg); color: var(--green); }
  .word-pill.flop { background: var(--red-bg); color: var(--red); }
  .empty-note { color: var(--ink-faint); font-size: 13px; }

  h2.section-title { font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); margin: 0 0 12px; }

  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  @media (max-width: 760px) { .grid3 { grid-template-columns: 1fr; } }
  .panel { border-radius: var(--radius); padding: 16px; border: 1px solid var(--border); background: var(--card); }
  .panel-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-weight: 700; font-size: 14px; }
  .panel.do-more { border-top: 4px solid var(--green); }
  .panel.stop { border-top: 4px solid var(--red); }
  .panel.fix { border-top: 4px solid var(--amber); }

  .mini-card { display: flex; gap: 10px; text-decoration: none; color: inherit; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .mini-card:last-child { border-bottom: none; }
  .mini-thumb { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: var(--neutral-bg); flex-shrink: 0; }
  .mini-caption { font-size: 12.5px; margin: 0 0 4px; line-height: 1.35; color: var(--ink); }
  .mini-score { font-size: 11px; color: var(--ink-faint); font-weight: 600; }

  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  @media (max-width: 700px) { .stats-row { grid-template-columns: repeat(2, 1fr); } }
  .stat-tile { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .stat-num { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 12.5px; color: var(--ink-faint); margin-top: 2px; }

  .card {
    display: flex; gap: 16px; align-items: center;
    background: var(--card); border: 1px solid var(--border); border-left-width: 5px;
    border-radius: var(--radius); padding: 14px 18px; margin-bottom: 12px;
  }
  .card.rank-top { border-left-color: var(--green); }
  .card.rank-bottom { border-left-color: var(--red); }
  .card.rank-mismatch { border-left-color: var(--amber); }
  .card.rank-neutral { border-left-color: var(--border); }

  .thumb-link { flex-shrink: 0; }
  .thumb { width: 72px; height: 72px; border-radius: 10px; object-fit: cover; background: var(--neutral-bg); display: block; }

  .card-body { flex: 1; min-width: 0; }
  .card-top { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .rank { font-size: 12px; font-weight: 700; color: var(--ink-faint); }
  .tag { font-size: 11.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .tag-green { background: var(--green-bg); color: var(--green); }
  .tag-red { background: var(--red-bg); color: var(--red); }
  .tag-amber { background: var(--amber-bg); color: var(--amber); }
  .tag-neutral { background: var(--neutral-bg); color: var(--neutral); }

  .caption { font-size: 13.5px; color: var(--ink-soft); margin: 0 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .axes { display: flex; flex-direction: column; gap: 3px; max-width: 360px; }
  .axis-row { display: grid; grid-template-columns: 40px 1fr 28px; align-items: center; gap: 8px; font-size: 11px; color: var(--ink-faint); }
  .axis-row.axis-empty { opacity: 0.5; }
  .axis-track { height: 6px; background: var(--neutral-bg); border-radius: 999px; overflow: hidden; }
  .axis-fill { height: 100%; border-radius: 999px; }
  .axis-fill.axis-hook { background: var(--accent); }
  .axis-fill.axis-reach { background: #2196a8; }
  .axis-fill.axis-viral { background: #d9539a; }
  .axis-value { text-align: right; font-variant-numeric: tabular-nums; }

  .card-right { text-align: right; flex-shrink: 0; padding-left: 8px; }
  .hook-score { font-size: 22px; font-weight: 700; line-height: 1; }
  .hook-score-label { font-size: 10.5px; color: var(--ink-faint); margin: 2px 0 8px; }
  .open-link { font-size: 12px; color: var(--accent); text-decoration: none; font-weight: 600; white-space: nowrap; }
  .open-link:hover { text-decoration: underline; }

  footer { text-align: center; color: var(--ink-faint); font-size: 12px; margin-top: 40px; }
</style>

<div class="wrap">
  <header class="page-head">
    <h1>📊 Instagram Reels Report</h1>
    <div class="subtitle">${windowLabel} · ${posts.length} Reel${posts.length === 1 ? "" : "s"} analyzed</div>
  </header>

  <section class="card-shell headline">
    ${
      headlineMultiple != null
        ? `<span class="big">${headlineMultiple.toFixed(1)}×</span>
           <span class="text">Your top Reel reached <strong>${headlineMultiple.toFixed(1)}× your median reach</strong> (${fmtCompact(topReel?.reach)} vs. ${fmtCompact(medianReach)} median).</span>`
        : `<span class="text">Not enough reach data yet to compute a headline multiplier.</span>`
    }
  </section>

  <section class="card-shell">
    <h2 class="section-title">Caption patterns</h2>
    ${
      winners.length === 0 && flops.length === 0
        ? `<p class="empty-note">No consistent caption word pattern between your top and bottom performers yet — need more Reels to be confident.</p>`
        : `<div class="pattern-grid">
             <div class="pattern-col">
               <h3>🟢 Winners use</h3>
               ${winners.length ? winners.map((w) => `<span class="word-pill win">${escapeHtml(w)}</span>`).join("") : `<span class="empty-note">nothing distinctive</span>`}
             </div>
             <div class="pattern-col">
               <h3>🔴 Flops use</h3>
               ${flops.length ? flops.map((w) => `<span class="word-pill flop">${escapeHtml(w)}</span>`).join("") : `<span class="empty-note">nothing distinctive</span>`}
             </div>
           </div>`
    }
  </section>

  <section>
    <h2 class="section-title">Action grid</h2>
    <div class="grid3">
      <div class="panel do-more">
        <div class="panel-head">🟢 Do More</div>
        ${top3.length ? top3.map(miniCard).join("") : `<p class="empty-note">Not enough scored Reels yet.</p>`}
      </div>
      <div class="panel stop">
        <div class="panel-head">🔴 Stop</div>
        ${bottom3.length ? bottom3.map(miniCard).join("") : `<p class="empty-note">Not enough scored Reels yet.</p>`}
      </div>
      <div class="panel fix">
        <div class="panel-head">🟡 Fix</div>
        ${fixCandidates.length ? fixCandidates.map(miniCard).join("") : `<p class="empty-note">No clear packaging mismatches this window — nice.</p>`}
      </div>
    </div>
  </section>

  <section>
    <h2 class="section-title">Quick stats</h2>
    <div class="stats-row">
      <div class="stat-tile">
        <div class="stat-num">${reachConcentration != null ? `${reachConcentration.toFixed(0)}%` : "—"}</div>
        <div class="stat-label">reach concentration (top reel)</div>
      </div>
      <div class="stat-tile">
        <div class="stat-num">${watchTimeGap != null ? `${watchTimeGap.toFixed(1)}s` : "—"}</div>
        <div class="stat-label">watch-time gap (best − worst)</div>
      </div>
      <div class="stat-tile">
        <div class="stat-num">${strongHookCount}</div>
        <div class="stat-label">strong-hook Reels (≥ ${STRONG_HOOK_S}s watch)</div>
      </div>
      <div class="stat-tile">
        <div class="stat-num">${replayWinnerCount}</div>
        <div class="stat-label">replay winners (replay ≥ ${REPLAY_WINNER_RATE}×)</div>
      </div>
    </div>
  </section>

  <section>
    <h2 class="section-title">Full ranked list</h2>
    ${ranked
      .map((p, i) => {
        const rank = i + 1;
        let borderClass = "rank-neutral";
        if (top3Ids.has(p.id)) borderClass = "rank-top";
        else if (bottom3Ids.has(p.id)) borderClass = "rank-bottom";
        else if (p.diagnosis.isPackagingMismatch) borderClass = "rank-mismatch";
        return postCard(p, rank, borderClass);
      })
      .join("")}
  </section>

  <footer>Generated by ig-reels-report · re-run any time with <code>npm run report</code></footer>
</div>
`;

  await writeFile(REPORT_PATH, html, "utf8");
  console.log(`\n✔ Wrote ${path.relative(process.cwd(), REPORT_PATH)}`);
  console.log(`  Open it: file://${REPORT_PATH}\n`);
}

main().catch((err) => {
  console.error("\n✖", err instanceof Error ? (err.stack ?? err.message) : String(err), "\n");
  process.exit(1);
});
