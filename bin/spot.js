#!/usr/bin/env node
// Tiny CLI over the same client: `spot <command> [json-args]`
import { readFileSync } from "node:fs";
import { spotify, api } from "../src/spotify.js";
import * as A from "../src/analysis.js";
import { budget } from "../src/budget.js";

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  me: () => spotify.me(),
  playlists: () => spotify.listPlaylists(),
  playlist: (id) => spotify.getPlaylist(id),
  create: (name, description) => spotify.createPlaylist({ name, description }),
  rename: (id, name) => spotify.updatePlaylist(id, { name }),
  describe: (id, description) => spotify.updatePlaylist(id, { description }),
  add: (id, ...tracks) => spotify.addTracks(id, tracks),
  remove: (id, ...tracks) => spotify.removeTracks(id, tracks),
  delete: (id) => spotify.deletePlaylist(id),
  merge: (json) => spotify.mergePlaylists(JSON.parse(json)),
  saved: () => spotify.savedTracks(),
  search: (q, type, limit) => spotify.search(q, type, limit && Number(limit)),
  top: (range, limit) => spotify.topTracks(range, limit && Number(limit)),
  "top-artists": (range, limit) => spotify.topArtists(range, limit && Number(limit)),
  recent: (limit) => spotify.recentlyPlayed(limit && Number(limit)),
  summary: (id) => (id ? A.summarizePlaylist(id) : A.summarizeLibrary()),
  find: (q) => A.findInPlaylists(q),
  dupes: () => A.dedupeReport(),
  diff: (a, b) => A.playlistDiff(a, b),
  snapshot: (label) => A.snapshotLibrary(label),
  changes: (file) => A.changesSince(file),
  // Deletes exactly the playlists listed in a file written by a test run ({description, playlists: [{id, name}]}).
  // Each one must still be yours, carry the same name and the file's description marker, or it's left alone.
  "delete-listed": async (file) => {
    const { description, playlists } = JSON.parse(readFileSync(file, "utf8"));
    if (!description || !playlists?.length) throw new Error(`${file} has no description marker or no playlists`);
    const me = (await spotify.me()).id;
    const out = [];
    for (const p of playlists) {
      const cur = await api("GET", `/playlists/${p.id}`, { query: { fields: "name,description,owner(id)" } }).catch(() => null);
      if (!cur) { out.push({ name: p.name, status: "not found (already deleted?)" }); continue; }
      const marker = description.slice(0, 17); // "TEST naming trial": the description may come back HTML-escaped
      if (cur.owner?.id !== me || cur.name !== p.name || !(cur.description ?? "").includes(marker)) { out.push({ name: p.name, status: "skipped: no longer matches the file" }); continue; }
      await spotify.deletePlaylist(p.id);
      out.push({ name: p.name, status: "deleted" });
    }
    return out;
  },
  index: async () => ({ coverage: (await A.libraryIndex()).coverage, budget: budget.status().api }),
  budget: () => budget.status(),
  rediscover: (years, limit) => A.rediscover({ minYearsAgo: years && Number(years), limit: limit && Number(limit) }),
};
if (!commands[cmd]) {
  console.error("Usage: spot <" + Object.keys(commands).join("|") + "> [args]");
  process.exit(2);
}
try {
  const out = await commands[cmd](...rest);
  console.log(JSON.stringify(out ?? { ok: true }, null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
