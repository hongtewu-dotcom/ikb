import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const Binding = z.object({
  root: z.string(), scope: z.enum(["work", "personal"]), createdAt: z.number().finite(),
  cards: z.array(z.tuple([z.string(), z.object({ path: z.string(), contentHash: z.string() }).strict()])),
}).strict();

// Each search owns one file; atomic rename prevents partial reads and lost updates
// between independent CLI processes. No card text or daemon is retained.
export function createDiskRetrievalStore(options = {}) {
  const directory = resolve(options.directory ?? process.env.IKB_RETRIEVAL_CACHE_DIR ?? join(homedir(), ".cache/ikb/retrievals"));
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new Error("IKB retrieval cache must be a private directory owned by the current user");
    }
  }
  async function read(id) {
    if (!ID.test(id)) throw new Error("Invalid retrieval_id");
    let handle;
    try {
      handle = await open(join(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Invalid retrieval cache file");
      return Binding.parse(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally { await handle?.close(); }
  }
  async function prune(core, keepId) {
    const live = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      const entry = await read(id);
      if (!entry) continue;
      if (entry.createdAt <= core.now() - core.retrievalTtlMs) await unlink(join(directory, name)).catch(ignoreMissing);
      else live.push({ id, createdAt: entry.createdAt });
    }
    live.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let excess = live.length - core.maxRetrievals;
    for (const item of live) {
      if (excess <= 0) break;
      if (item.id === keepId) continue;
      await unlink(join(directory, `${item.id}.json`)).catch(ignoreMissing);
      excess--;
    }
  }
  return {
    directory,
    async save(id, retrieval, core) {
      if (!ID.test(id)) throw new Error("Invalid retrieval_id");
      await prepare();
      const value = Binding.parse({ ...retrieval, root: await realpath(core.rootDir), cards: [...retrieval.cards] });
      const temporary = join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(value), "utf8"); } finally { await handle.close(); }
        await rename(temporary, join(directory, `${id}.json`));
      } finally { await unlink(temporary).catch(ignoreMissing); }
      await prune(core, id);
    },
    async load(id, core) {
      await prepare();
      await prune(core, id);
      const entry = await read(id);
      if (!entry || entry.createdAt <= core.now() - core.retrievalTtlMs) return null;
      if (entry.root !== await realpath(core.rootDir)) throw new Error("Retrieval belongs to a different cards root");
      return { ...entry, cards: new Map(entry.cards) };
    },
  };
}

function ignoreMissing(error) { if (error.code !== "ENOENT") throw error; }
