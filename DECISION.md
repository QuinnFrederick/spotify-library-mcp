# Decision: base for Quinn's Spotify MCP

*2026-09-27*

## Verdict: fork B (oliver-virt/spotify-library-mcp). Retire listening-room.

**Why B:** its roughly 600 lines of MCP code hold real lessons from running against the live API that ours doesn't have:
- a persistent `/search` budget with a result cache and **memory of a ~21-hour 429 ban**, so the server fails fast instead of sleeping for 21 hours
- 150 ms request pacing, added after about 500 rapid calls got the client silently dropped at the TLS level
- the Feb-2026 migration handled correctly: `/items` with entries under `item`, `/me/library` with a 20-URI chunk limit, `POST /me/playlists`, and removed endpoints refused before any request goes out
- a karaoke- and cover-proof `find_track`

It also already has every capability on the list: list, rename, create, merge, delete, add and remove tracks, snapshots with "what changed since", liked songs in no playlist, stale and empty playlists, duplicates, overlaps, and rediscover. The mock-Spotify test suite covers the whole MCP over both stdio and HTTP.

**Why not ours:** listening-room's MCP was built for the opposite job. It deliberately returns *no* Spotify content (no titles, playlists or ids), it reads a Supabase catalogue, and its Spotify client only does GET and PUT, with no playlist writes. Salvaging it would mean a rewrite. Its generic client ideas have been ported instead (see below).

## What was cut
- **From B:** the iOS app (`app/Sorted`), landing, store and privacy pages, App Store material, MusicKit and Foundation Models research probes, artwork, Oliver's personal curation scripts (`build`, `classify`, `curate`, `moods`, `nostalgia`, `explore`, `genz`, `trending`, `pull`, `lib`), the Cloudflare quick-tunnel script, and his "Hebrew share" metric.
- **Kept:** the MCP (`src/`), the stdio and HTTP entries, the one-time PKCE `scripts/auth.js`, and the small CLI (`bin/spot.js`, which shares the same client and is the easiest way to check auth works).
- **listening-room:** left untouched, as the brief says. Its leftover `next start -p 3217` server was stopped. Git history keeps everything.

## What was fixed or ported (some ideas from listening-room; B is credited in README)
- **Origin guard** (from ours): `next` pagination links are absolute URLs. B would send the bearer token to any host a response named. Now only the API origin is allowed.
- **Rotated refresh token is persisted.** Under PKCE, Spotify rotates refresh tokens. B kept the new one only in memory, so a restart could fall back to a dead token. It is now written back to `.env`.
- **Token-endpoint errors** now return only the OAuth error code, never the response body (same approach as ours). `invalid_grant` says "re-run `npm run auth`" (refresh tokens last about 6 months).
- **Search `limit` capped at 10**, the Feb-2026 maximum. B allowed 50, which would fail.
- Dropped the removed `popularity` and `genres` fields. Removed "use a second Spotify app" advice, because it's now one client id per developer.
- Server instructions now tell the model to **`snapshot_library` before bulk renames, merges or deletes** and to confirm first. They also mention the ~90-day playlist recovery page and that folders aren't in the API.
- `scripts/auth.js`: runs `execFile("open", …)` instead of passing the URL through a shell.
- `src/http.js`: request bodies are capped at 1 MB.
- **Tests:** 16 pass (B's 12, plus the origin guard, the search clamp, token rotation with a 0600 file, and the re-auth hint). The e2e test no longer overwrites the real `.env`; it uses a temp file via `SPOTIFY_ENV_FILE`.

## Security read (this code holds the token)
- **Where the token lives:** the refresh token is in `.env` in the repo folder, plain text, now mode 0600 and git-ignored. The access token is in memory only. No client secret is needed (PKCE).
- **What gets logged:** no tokens. The auth script prints the authorize URL, which contains only the PKCE challenge. The HTTP entry logs error stacks to stderr.
- **Network:** only `accounts.spotify.com` and `api.spotify.com`. There's no telemetry and no third-party calls. `SPOTIFY_ACCOUNTS_URL` and `SPOTIFY_API_URL` can override those hosts, but they exist for tests. Anyone who can edit your environment could point them elsewhere, which is the same trust level as `.env` itself.
- **Local files with library data (git-ignored):** `backups/` holds snapshots and `.search-budget.json` holds the search cache.
- **HTTP entry:** binds to 127.0.0.1, and the path secret is compared in constant time. On its own it has **no real auth**, so it should only ever be reached through your OAuth gateway, never a public tunnel. That's why `tunnel.sh` was removed.
- **Policy flag:** listening-room's rule was that Spotify content must never reach an LLM. Spotify's Developer Terms forbid ingesting Spotify content into AI models. This MCP's whole purpose is to show your playlists and tracks to Claude. It's your own data on a single-user dev-mode app, but the worst case is Spotify revoking the app. That rule has **not** been carried over; this is your call. Spotify's official Claude connector exists if you ever want the sanctioned route for basics.

## Live test and a 24-hour lockout (2026-10-12)

The first test against your real account (546 owned playlists) tripped Spotify's limit. Listing, the token refresh and a verified search all worked. Then the full-library read (≈500+ calls in under 3 minutes) got a 429 on **every endpoint**, with a ~24-hour retry-after (until about 16:24 BST on 13 October). Nothing in your library changed. Oliver's ~40-playlist library never came close to this limit.

**Fixed since:**
- every non-search call now counts against a daily cap (400)
- a long 429 on any endpoint is remembered, and no calls are sent until it lifts. The current lockout is already recorded in `.search-budget.json`.
- playlists are cached on disk by `snapshot_id`, so only changed ones are re-read
- the first full index spreads over about two days and resumes by itself; until it's complete, the tools report `coverage`
- reading a playlist now takes one call instead of two

The test suite now has 18 tests. The live write test (create, add, rename, remove and delete a throwaway playlist) is still to do once the lockout lifts.

## What Quinn does next
1. Fix GitHub auth (`gh auth login`), then publish the fork: `cd ~/code/spotify-library-mcp && gh repo fork --remote --remote-name origin`. Oliver's repo is already set as `upstream`, and the local commits sit on top of it. (`gh` was logged out, so I couldn't fork it.)
2. At developer.spotify.com, create (or reuse) your one app, add the redirect URI `http://127.0.0.1:8888/callback`, and put the Client ID in `.env`. Dev-mode apps need the owner to have Premium.
3. Run `npm run auth` and approve in the browser, then check it with `node bin/spot.js playlists`.
4. Add it to Claude Code (done 2026-10-12, user scope):

   ```bash
   claude mcp add --scope user spotify-library -- node /Users/quinn/code/spotify-library-mcp/src/server.js
   ```

   After the lockout lifts, run `npm run index` once a day until it reports `"complete": true` (about two days). Then try `summarize_library` in Claude.
5. Later, for the phone: run `npm run start:http` under launchd on 127.0.0.1 and mount it on the OAuth gateway, following the WhatsApp MCP pattern in mac-mini-dev. Don't put `SPOTIFY_REFRESH_TOKEN` in the plist, because real environment variables override `.env` and would win over the rotated token.
