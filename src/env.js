import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Overridable so tests never touch the real .env.
export const ENV_FILE = process.env.SPOTIFY_ENV_FILE ?? join(ROOT, ".env");

// Minimal .env loader (no dependency). Real env vars win over the file.
export function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const raw of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// Upsert KEY=value in the .env file and keep it owner-readable only (it holds the refresh token).
export function setEnvValue(key, value) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, () => `${key}=${value}`);
  else text += `${text.endsWith("\n") || !text ? "" : "\n"}${key}=${value}\n`;
  writeFileSync(ENV_FILE, text, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}
