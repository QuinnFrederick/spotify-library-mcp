import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { start } from "./mock-spotify.js";

let mock, dir;
before(async () => { mock = await start(); dir = mkdtempSync(join(tmpdir(), "dl-")); });
after(() => mock.server.close());

// Async spawn: the mock Spotify lives in this process.
const run = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { cwd: join(import.meta.dirname, ".."), env });
  let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
  c.on("exit", (code) => resolve({ code, out, err }));
});

test("delete-listed removes only listed playlists that still match name and marker", async () => {
  const marker = "TEST naming trial — delete after";
  mock.state.playlists.get("p2").description = marker;           // matches: deleted
  mock.state.playlists.get("p3").description = "my real playlist"; // marker gone: skipped
  const file = join(dir, "t.json");
  writeFileSync(file, JSON.stringify({ description: marker, playlists: [
    { id: "p2", name: "Workout" }, { id: "p3", name: "Workout copy" }, { id: "p9", name: "gone" } ] }));
  const env = { ...process.env, SPOTIFY_ACCOUNTS_URL: mock.url, SPOTIFY_API_URL: mock.url + "/v1", SPOTIFY_CLIENT_ID: "mock", SPOTIFY_REFRESH_TOKEN: "rt-mock-1", SPOTIFY_MIN_GAP_MS: "0", SPOTIFY_ENV_FILE: join(dir, ".env"), SPOTIFY_BUDGET_FILE: join(dir, "b.json"), SPOTIFY_CACHE_DIR: join(dir, "cache") };
  const r = await run(["bin/spot.js", "delete-listed", file], env);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).map((x) => x.status), ["deleted", "skipped: no longer matches the file", "not found (already deleted?)"]);
  assert.ok(!mock.state.playlists.has("p2") && mock.state.playlists.has("p3") && mock.state.playlists.has("p1"));
});
