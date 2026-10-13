// Library index with a disk cache, built to survive large libraries (hundreds of playlists).
// - Each owned playlist is cached under cache/playlists/<id>.json with its snapshot_id; it is re-read only when
//   Spotify's listing reports a different snapshot_id. A refresh of an unchanged library costs ~1 call per 50 playlists.
// - Fetching stops when today's call budget is down to RESERVE, leaving headroom for interactive tools. The index
//   is then partial (coverage says so) and the next call resumes where this one stopped.
// - Liked songs are fetched newest-first and merged into the cache until a known track is reached; a full re-read
//   (to notice un-likes) happens every LIKED_FULL_DAYS, also resumably.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spotify, api } from "./spotify.js";
import { BudgetError } from "./budget.js";
import { ROOT } from "./env.js";

const CACHE_DIR = process.env.SPOTIFY_CACHE_DIR ?? join(ROOT, "cache");
const RESERVE = Number(process.env.SPOTIFY_INDEX_RESERVE ?? 50);
const TTL = Number(process.env.SPOTIFY_INDEX_TTL_MS ?? 10 * 60 * 1000);
const LIKED_FULL_DAYS = Number(process.env.SPOTIFY_LIKED_FULL_DAYS ?? 7);
const LISTING_TTL = Number(process.env.SPOTIFY_LISTING_TTL_MS ?? 60 * 60 * 1000);

const plDir = () => join(CACHE_DIR, "playlists");
const read = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const write = (f, v) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, JSON.stringify(v)); };
const slimLiked = (i) => ({ added_at: i.added_at, id: i.track?.id, uri: i.track?.uri, name: i.track?.name, artists: (i.track?.artists ?? []).map((a) => a.name).join(", "), album: i.track?.album?.name, duration_ms: i.track?.duration_ms, release: i.track?.album?.release_date });

let memo = null, memoAt = 0, relistNext = false;

// The playlist listing (~16 calls for 775 playlists) is saved to cache/playlists.json and reused for LISTING_TTL,
// so an index run interrupted by the budget doesn't pay for it again. `relist` forces a fresh one.
async function listing(relist) {
  const file = join(CACHE_DIR, "playlists.json");
  const c = read(file);
  if (c && !relist && !relistNext && !c.partial && Date.now() - Date.parse(c.fetched_at) < LISTING_TTL) return c.playlists.map((p) => ({ ...p, mine: p.mine ?? p.owner === c.me }));
  const playlists = await spotify.listPlaylists();
  relistNext = false;
  write(file, { fetched_at: new Date().toISOString(), total_reported: playlists.length, playlists });
  return playlists;
}

export async function libraryIndex({ refresh = false } = {}) {
  if (memo && !refresh && Date.now() - memoAt < TTL) return memo;
  const listed = (await listing(refresh)).filter((p) => p.mine);
  const playlists = {}, unindexed = [];
  let stopped = null;
  for (const p of listed) {
    const file = join(plDir(), `${p.id}.json`);
    const cached = read(file);
    if (cached && cached.snapshot_id === p.snapshot_id) { playlists[p.id] = { ...cached, name: p.name, description: p.description }; continue; }
    if (p.tracks === 0) { // the listing already says it's empty: no call needed
      const entry = { id: p.id, name: p.name, description: p.description, snapshot_id: p.snapshot_id, tracks: [] };
      write(file, entry); playlists[p.id] = entry; continue;
    }
    if (!stopped) {
      try {
        const tracks = await spotify.playlistTracks(p.id, { reserve: RESERVE });
        const entry = { id: p.id, name: p.name, description: p.description, snapshot_id: p.snapshot_id, tracks };
        write(file, entry);
        playlists[p.id] = entry;
        continue;
      } catch (e) {
        if (!(e instanceof BudgetError)) throw e;
        stopped = e.message;
      }
    }
    // Not fetched: keep a stale copy if we have one (flagged), otherwise leave it out of the analysis.
    if (cached) playlists[p.id] = { ...cached, name: p.name, outdated: true };
    unindexed.push(p.id);
  }
  const liked = await likedIndex(stopped);
  const coverage = {
    complete: unindexed.length === 0 && liked.complete,
    playlists_owned: listed.length,
    playlists_indexed: listed.length - unindexed.length,
    playlists_outdated_or_missing: unindexed.length,
    liked_complete: liked.complete,
    ...(stopped || liked.stopped ? { stopped_because: stopped ?? liked.stopped, resume: "Call again after the budget resets (midnight UTC), or run `npm run index` later; progress is kept." } : {}),
  };
  memo = { playlists, unindexed: new Set(unindexed), liked: liked.tracks, coverage, fetchedAt: new Date().toISOString() };
  memoAt = Date.now();
  return memo;
}

async function likedIndex(alreadyStopped) {
  const file = join(CACHE_DIR, "liked.json");
  const c = read(file) ?? { tracks: [], complete: false, next: null, fullAt: null, partial: [] };
  if (alreadyStopped) return { tracks: c.complete ? c.tracks : [...c.tracks], complete: c.complete, stopped: null };
  const due = !c.fullAt || Date.now() - Date.parse(c.fullAt) > LIKED_FULL_DAYS * 864e5;
  try {
    if (c.complete && !due) {
      // incremental: newest-first pages until we reach a track we already have
      const known = new Set(c.tracks.map((t) => t.id));
      const fresh = [];
      let page = await api("GET", "/me/tracks", { query: { limit: 50 }, reserve: RESERVE });
      for (;;) {
        const items = page.items.map(slimLiked).filter((t) => t.id);
        const cut = items.findIndex((t) => known.has(t.id));
        fresh.push(...(cut < 0 ? items : items.slice(0, cut)));
        if (cut >= 0 || !page.next) break;
        page = await api("GET", page.next, { reserve: RESERVE });
      }
      if (fresh.length) { c.tracks = [...fresh, ...c.tracks]; write(file, c); }
      return { tracks: c.tracks, complete: true, stopped: null };
    }
    // full (re)read, resumable via c.next; c.partial accumulates until done
    if (!c.next) c.partial = [];
    let page = await api("GET", c.next ?? "/me/tracks", c.next ? { reserve: RESERVE } : { query: { limit: 50 }, reserve: RESERVE });
    for (;;) {
      c.partial.push(...page.items.map(slimLiked).filter((t) => t.id));
      c.next = page.next;
      write(file, c);
      if (!page.next) break;
      page = await api("GET", page.next, { reserve: RESERVE });
    }
    Object.assign(c, { tracks: c.partial, partial: [], next: null, complete: true, fullAt: new Date().toISOString() });
    write(file, c);
    return { tracks: c.tracks, complete: true, stopped: null };
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e;
    // A previous complete list is still usable (just possibly a little stale).
    return { tracks: c.tracks.length ? c.tracks : c.partial, complete: c.complete, stopped: e.message };
  }
}

// Forget the in-memory memo (after writes made through the tools, so the next analysis re-lists).
export function invalidate() { memo = null; relistNext = true; }
