import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./mock-spotify.js";

let mock, envFile;
before(async () => {
  mock = await start();
  const dir = mkdtempSync(join(tmpdir(), "tokens-"));
  envFile = join(dir, ".env");
  writeFileSync(envFile, "SPOTIFY_CLIENT_ID=mock\nSPOTIFY_REFRESH_TOKEN=rt-mock-1\n");
  Object.assign(process.env, { SPOTIFY_ENV_FILE: envFile, SPOTIFY_ACCOUNTS_URL: mock.url, SPOTIFY_API_URL: mock.url + "/v1", SPOTIFY_MIN_GAP_MS: "0", SPOTIFY_BUDGET_FILE: join(dir, "b.json") });
});
after(() => mock.server.close());

test("a rotated refresh token is persisted to .env (0600), so a restart doesn't use a dead one", async () => {
  mock.state.rotateRefresh = true;
  const { refreshAccessToken } = await import("../src/spotify.js");
  await refreshAccessToken();
  const saved = readFileSync(envFile, "utf8");
  assert.match(saved, new RegExp(`^SPOTIFY_REFRESH_TOKEN=${mock.state.refreshToken}$`, "m"));
  assert.match(saved, /^SPOTIFY_CLIENT_ID=mock$/m, "other keys untouched");
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
});

test("an expired/revoked refresh token gives a re-auth hint and no response body", async () => {
  const { refreshAccessToken } = await import("../src/spotify.js");
  process.env.SPOTIFY_REFRESH_TOKEN = "rt-dead";
  await assert.rejects(refreshAccessToken(), (e) => /invalid_grant/.test(e.message) && /npm run auth/.test(e.message) && !/rt-dead/.test(e.message));
});
