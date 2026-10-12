import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./mock-spotify.js";

let mock, budget, libraryIndex, spotify;
before(async () => {
  mock = await start();
  const dir = mkdtempSync(join(tmpdir(), "index-"));
  Object.assign(process.env, { SPOTIFY_ACCOUNTS_URL: mock.url, SPOTIFY_API_URL: mock.url + "/v1", SPOTIFY_CLIENT_ID: "mock", SPOTIFY_REFRESH_TOKEN: "rt-mock-1", SPOTIFY_MIN_GAP_MS: "0", SPOTIFY_BUDGET_FILE: join(dir, "b.json"), SPOTIFY_CACHE_DIR: join(dir, "cache"), SPOTIFY_INDEX_TTL_MS: "0", SPOTIFY_DAILY_CALL_CAP: "5", SPOTIFY_INDEX_RESERVE: "1" });
  ({ budget } = await import("../src/budget.js"));
  ({ libraryIndex } = await import("../src/library.js"));
  ({ spotify } = await import("../src/spotify.js"));
  budget._reset();
});
after(() => mock.server.close());

test("index stops at the daily budget with partial coverage, then resumes and only re-reads what changed", async () => {
  // day 1: listing (2 calls) + 2 playlists, then the reserve stops it
  let idx = await libraryIndex();
  assert.equal(idx.coverage.complete, false);
  assert.equal(idx.coverage.playlists_indexed, 2);
  assert.equal(idx.coverage.playlists_owned, 3);
  assert.match(idx.coverage.stopped_because, /budget/);
  assert.equal(budget.status().api.calls, 4, "never spends the reserved last call");

  // day 2: the cached two are reused, the third and liked songs are fetched
  budget._reset();
  let n0 = mock.state.authedRequests;
  idx = await libraryIndex({ refresh: true });
  assert.equal(idx.coverage.complete, true);
  assert.equal(idx.liked.length, 3);
  assert.equal(mock.state.authedRequests - n0, 4, "listing 2 + one playlist + one liked page");

  // unchanged library: listing + one liked page only. Then a change to one playlist re-reads just that one.
  budget._reset();
  n0 = mock.state.authedRequests;
  await libraryIndex({ refresh: true });
  assert.equal(mock.state.authedRequests - n0, 3);
  await spotify.saveTracks(["t8"]);
  await spotify.addTracks("p2", ["t9"], { dedupe: false });
  budget._reset();
  n0 = mock.state.authedRequests;
  idx = await libraryIndex({ refresh: true });
  assert.equal(mock.state.authedRequests - n0, 4, "listing 2 + p2 + liked head");
  assert.deepEqual(idx.playlists.p2.tracks.map((t) => t.id), ["t3", "t4", "t9"]);
  assert.equal(idx.liked[0].id, "t8", "new like merged at the head");
});

test("a long 429 on any endpoint bans the whole app: nothing else is sent until it lifts", async () => {
  budget._reset();
  mock.state.apiStatus = [429, 85784];
  const n0 = mock.state.authedRequests;
  await assert.rejects(spotify.listPlaylists(), /rate limit.*23\.8h/);
  mock.state.apiStatus = null;
  await assert.rejects(spotify.topTracks(), /rate-limited this app until/);
  assert.equal(mock.state.authedRequests - n0, 1, "only the call that got the 429 reached Spotify");
  const s = budget.status();
  assert.ok(s.api.banned_until);
  assert.equal(s.last_ban.retry_after_s, 85784);
  assert.equal(s.last_ban.path, "/v1/me");
  assert.equal(s.search.banned_until, null, "search has its own bucket");
});
