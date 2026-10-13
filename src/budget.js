// Persistent request budgets + ban memory. State lives in .search-budget.json (git-ignored).
// - /search: roughly 1000/day per app; crossing it returns 429 with retry-after ≈ 21h.
// - everything else: walking ~550 playlists (~500+ calls in ~3 min) got the WHOLE app a 429 with
//   retry-after ≈ 24h (2026-10-12). So non-search calls get a daily cap too, and long bans are remembered.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";

const FILE = process.env.SPOTIFY_BUDGET_FILE ?? join(ROOT, ".search-budget.json");
export const DAILY_CAP = Number(process.env.SPOTIFY_SEARCH_DAILY_CAP ?? 800); // safety margin under ~1000
// 2026-10-12: ~350 bursty calls (150 ms gap) plus another session's share tripped a 24h ban.
// 2026-10-13: 703 calls at 1 s pacing went through cleanly. So pacing matters more than the count; 600 is under the proven figure. lastBan records what actually tripped it, so this can be tuned.
export const DAILY_CALL_CAP = Number(process.env.SPOTIFY_DAILY_CALL_CAP ?? 600);
const CACHE_MAX = 5000;

const today = () => new Date().toISOString().slice(0, 10);
const fresh = () => ({ day: today(), used: 0, calls: 0, bannedUntil: 0, apiBannedUntil: 0, lastBan: null, cache: {} });
function load() {
  if (!existsSync(FILE)) return fresh();
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    // Counters reset daily; bans, ban history and the search cache survive.
    return s.day === today() ? { ...fresh(), ...s } : { ...fresh(), bannedUntil: s.bannedUntil ?? 0, apiBannedUntil: s.apiBannedUntil ?? 0, lastBan: s.lastBan ?? null, cache: s.cache ?? {} };
  } catch { return fresh(); }
}
let state = load();
const save = () => writeFileSync(FILE, JSON.stringify(state));
// The file is the shared truth: a Claude Code MCP server and a CLI run (`npm run index`) are separate processes
// hitting the same per-app quota, so re-read before every check or spend. (load() also handles the day rollover.)
const sync = () => { state = load(); };
const iso = (ms) => (ms > Date.now() ? new Date(ms).toISOString() : null);

export class BudgetError extends Error {}

export const budget = {
  status() {
    sync();
    return {
      day: state.day,
      search: { used: state.used, cap: DAILY_CAP, remaining: Math.max(0, DAILY_CAP - state.used), banned_until: iso(state.bannedUntil), cached: Object.keys(state.cache).length },
      api: { calls: state.calls, cap: DAILY_CALL_CAP, remaining: Math.max(0, DAILY_CALL_CAP - state.calls), banned_until: iso(state.apiBannedUntil) },
      last_ban: state.lastBan,
      // flat fields kept for the search-budget callers
      used: state.used, cap: DAILY_CAP, remaining: Math.max(0, DAILY_CAP - state.used), banned: state.bannedUntil > Date.now(), bannedUntil: iso(state.bannedUntil), cached: Object.keys(state.cache).length,
    };
  },
  // Throw before any network call if a ban is active or the cap is reached.
  check() {
    const s = this.status();
    if (s.banned) throw new BudgetError(`Spotify /search is banned for this app until ${s.bannedUntil} (429 retry-after). Wait for it to lift.`);
    if (s.remaining <= 0) throw new BudgetError(`Daily /search budget exhausted (${s.used}/${s.cap}). Resets at midnight UTC; raise SPOTIFY_SEARCH_DAILY_CAP at your own risk.`);
  },
  checkApi({ reserve = 0 } = {}) {
    const s = this.status().api;
    if (s.banned_until) throw new BudgetError(`Spotify has rate-limited this app until ${s.banned_until} (429 retry-after). No calls are sent until then.`);
    if (s.remaining <= reserve) throw new BudgetError(`Daily Spotify call budget ${reserve ? "for background indexing " : ""}used up (${s.calls}/${s.cap}). Resets at midnight UTC; raise SPOTIFY_DAILY_CALL_CAP at your own risk.`);
  },
  spend() { sync(); state.used++; save(); },
  spendApi() { sync(); state.calls++; save(); },
  ban(seconds, path = "/search") {
    sync();
    const until = Date.now() + seconds * 1000;
    if (path.endsWith("/search")) state.bannedUntil = until; else state.apiBannedUntil = until;
    state.lastBan = { at: new Date().toISOString(), path, retry_after_s: seconds, calls_today: state.calls, searches_today: state.used };
    save();
  },
  cacheGet(key) { sync(); return state.cache[key]; },
  cacheSet(key, val) {
    sync();
    state.cache[key] = val;
    const keys = Object.keys(state.cache);
    if (keys.length > CACHE_MAX) for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete state.cache[k];
    save();
  },
  _reset() { state = fresh(); save(); },
};
