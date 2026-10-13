# spotify-library-mcp

Forked from [oliver-virt/spotify-library-mcp](https://github.com/oliver-virt/spotify-library-mcp) (MIT) and pruned to just the MCP server + CLI. See DECISION.md.

Local MCP server + CLI for managing **your own** Spotify library. Single user, runs on your machine, PKCE auth (no client secret needed).

## Setup (one time)

1. https://developer.spotify.com/dashboard → **Create app**
   - Redirect URI: `http://127.0.0.1:8888/callback`
   - API: Web API
2. Copy the **Client ID** into `.env` (`SPOTIFY_CLIENT_ID=...`)
3. `npm install && npm run auth` → browser opens → approve → refresh token is written to `.env` (mode 0600; rotated tokens are written back automatically)
4. Verify: `node bin/spot.js playlists`

## Use from Claude Code

`.mcp.json` in this folder registers the server for this project. For every project:

```bash
claude mcp add --scope user spotify-library -- node /path/to/spotify-library-mcp/src/server.js
```

## CLI

```
node bin/spot.js playlists
node bin/spot.js playlist <id>
node bin/spot.js rename <id> "New name"
node bin/spot.js merge '{"sourceIds":["a","b"],"newName":"Merged","deleteSources":true}'
node bin/spot.js delete <id>
node bin/spot.js top short_term 20
node bin/spot.js summary            # whole library
node bin/spot.js summary <id>       # one playlist
node bin/spot.js find "Sultans"     # which playlists contain it
node bin/spot.js dupes
node bin/spot.js diff <a> <b>
node bin/spot.js snapshot weekly && node bin/spot.js changes
node bin/spot.js rediscover 4 50
node bin/spot.js index              # build/refresh the playlist cache (budgeted, resumable)
node bin/spot.js budget             # today's call and search budgets, any active ban
```

## Tools

**Playlists** — list_playlists, get_playlist, create_playlist, update_playlist, add_tracks, remove_tracks, delete_playlist, merge_playlists
**Library** — get_saved_tracks, save_tracks, remove_saved_tracks, get_top_tracks, get_top_artists, get_recently_played
**Search** — search, find_track (artist-verified), get_search_budget, get_api_limits
**Analysis** (computed server-side, compact output — things Spotify users have asked for for a decade):
- `summarize_library` — liked songs in no playlist, stale/empty playlists, cross-playlist overlaps, decades, dupes
- `summarize_playlist` — runtime, top artists, decades, duplicates, over-representation
- `find_in_playlists` — "which of my playlists has this song?"
- `dedupe_report` — same artist+title ignoring remaster/live/edit suffixes, with ids to remove
- `playlist_diff` — only-in-A / only-in-B / shared
- `snapshot_library` · `list_snapshots` · `changes_since` — backup + "what changed since last week" (renames, adds, removes, likes)
- `rediscover` — liked years ago, absent from top tracks and recent plays; spread across artists

## Tests

`npm test` runs the whole flow against an in-memory mock Spotify (`test/mock-spotify.js`). No real credentials touched.

## Remote (HTTP) entry

`npm run start:http` serves Streamable HTTP at `127.0.0.1:$PORT/<MCP_SECRET>/mcp`. It is meant to sit behind an OAuth gateway on the same machine; the secret path is defence in depth, not the only gate. Don't expose it directly to the internet.

## Spotify API limits (2026, apps created after Nov 2024) — baked in

| What | Status | Handled how |
|---|---|---|
| `/audio-features`, `/recommendations`, `related-artists` | removed | client throws a clear error before any request |
| batch `GET /tracks?ids=`, `/artists?ids=` | 403 | same; use single-item endpoints |
| artist `genres`, `popularity` fields | gone | not returned |
| `/playlists/{id}/tracks` | renamed `/items`, entries under `item` | client uses new paths |
| `POST /users/{id}/playlists` | deprecated | `POST /me/playlists` |
| `PUT/DELETE /me/tracks` | deprecated | `/me/library?uris=` (max 20 per call, chunked) |
| `/search` `limit` | max 10 (was 50) | clamped in client and tool schema |
| name-only search | returns karaoke/covers | `find_track` tool verifies the artist |
| `/search` quota | **~1000/day per app → 429 with `retry-after ≈ 21h`** | persistent daily budget (default 800, `SPOTIFY_SEARCH_DAILY_CAP`), result cache, ban memory — see below |
| ~500 rapid calls | silent TLS-level drop for ~10 min (no 429) | 150 ms pacing + retry with backoff |
| ~500+ calls walking a big library | **429 on every endpoint, `retry-after ≈ 24h`** (2026-10-12, ~550 playlists) | daily call cap (default 400, `SPOTIFY_DAILY_CALL_CAP`), app-wide ban memory, disk-cached incremental index — see below |

`get_api_limits` tool returns this list to the model; the server's MCP `instructions` carry the summary too.

### Search budget (learned 2026-08-23)

~1,000 `/search` calls in one day got this app a `429` with `retry-after: 75469` (21 h). The limit is **per app (client id)**, not per user, and it's the only quota we've hit that locks you out for a day.

What the server does about it (`src/budget.js`, state in `.search-budget.json`):
- counts searches per UTC day and refuses past `SPOTIFY_SEARCH_DAILY_CAP` (default 800) with a clear error
- caches every search result, so reruns of a script cost 0 searches
- remembers a ban from a long `retry-after` and fails fast until it expires — no 21-hour sleeps
- `get_search_budget` tool / `searchBudget()` report remaining, cached, banned-until

Spotify now allows one client id per developer, so a second app is not an escape hatch.

### Large libraries (learned 2026-10-12)

Reading every playlist of a ~550-playlist library in one go (≈500+ calls in under 3 minutes) got the **whole app** a 429 with `retry-after: 85784` (≈24 h). Search kept working, so it has its own bucket. So:
- every non-search call counts against a daily cap (`SPOTIFY_DAILY_CALL_CAP`, default 400 — a guess below what tripped it; `last_ban` in `get_search_budget` records the count the next time one happens, so it can be tuned)
- a long 429 on any endpoint is remembered and nothing is sent until it lifts
- the analysis tools read playlists from `cache/` (git-ignored), keyed by each playlist's `snapshot_id`, so only changed playlists cost calls. Indexing stops 50 calls short of the cap (`SPOTIFY_INDEX_RESERVE`) and resumes on the next call or day; results carry `coverage` until it's complete
- `npm run index` builds or refreshes the cache outside a chat; `node bin/spot.js budget` shows today's counters

Measured 2026-10-13: a full index of 617 playlists + 2,335 liked songs took 703 calls at 1 s pacing in one sitting, no ban. The day before, ~350 calls at 150 ms pacing (plus another session) got a 24h ban. Pacing is what matters; the default is now 1 s and the cap 600. A refresh of an unchanged library costs roughly one call per 50 playlists.
