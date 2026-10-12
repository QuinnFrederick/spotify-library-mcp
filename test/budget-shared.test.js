import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { start } from "./mock-spotify.js";

let mock, file;
before(async () => {
  mock = await start();
  file = join(mkdtempSync(join(tmpdir(), "shared-")), "b.json");
  Object.assign(process.env, { SPOTIFY_ACCOUNTS_URL: mock.url, SPOTIFY_API_URL: mock.url + "/v1", SPOTIFY_CLIENT_ID: "mock", SPOTIFY_REFRESH_TOKEN: "rt-mock-1", SPOTIFY_MIN_GAP_MS: "0", SPOTIFY_BUDGET_FILE: file, SPOTIFY_CACHE_DIR: join(mkdtempSync(join(tmpdir(), "cache-")), "c") });
});
after(() => mock.server.close());

// Must be async: the mock Spotify lives in this process, so a blocking spawnSync would deadlock the child.
const run = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { cwd: join(import.meta.dirname, ".."), env: process.env });
  let err = ""; c.stderr.on("data", (d) => (err += d));
  c.on("exit", (code) => resolve({ code, err }));
});

test("the call budget is shared across processes (MCP server + CLI count against one quota)", async () => {
  const { spotify } = await import("../src/spotify.js");
  const { budget } = await import("../src/budget.js");
  budget._reset();
  await spotify.me();
  assert.equal(budget.status().api.calls, 1);
  const r = await run(["bin/spot.js", "me"]); // another process spends 1 call against the same file
  assert.equal(r.code, 0, r.err);
  assert.equal(budget.status().api.calls, 2, "this process sees the other process's call");
  // a ban written by another process stops this one before any network call
  const n0 = mock.state.authedRequests;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), apiBannedUntil: Date.now() + 3600e3 }));
  await assert.rejects(spotify.me(), /rate-limited this app until/);
  assert.equal(mock.state.authedRequests, n0);
});
