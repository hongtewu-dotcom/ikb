import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncLocalFiles } from "../src/files.ts";
import { listSources, readSourceRecords } from "../src/source.ts";

test("local file sync is recursive, filtered and incremental", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-local-files-"));
  const home = join(sandbox, "ikb-data");
  const root = join(sandbox, "memory");
  mkdirSync(join(root, "topics"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n\nCurrent rule.\n");
  writeFileSync(join(root, "topics", "one.md"), "# One\n\nFirst version.\n");
  writeFileSync(join(root, "archive", "old.md"), "# Old\n");
  writeFileSync(join(root, "ignore.json"), "{}\n");

  const options = { adapter: "catpaw-memory-local", kind: "manual" as const, scope: "work", extensions: [".md"], exclude: ["archive"] };
  const first = syncLocalFiles(home, root, options);
  assert.deepEqual({ discovered: first.discovered, imported: first.imported, skipped: first.skipped, failed: first.failed }, { discovered: 2, imported: 2, skipped: 0, failed: 0 });
  assert.equal(listSources(home).length, 2);
  assert.equal(listSources(home).every((source) => source.adapter === "catpaw-memory-local"), true);

  const second = syncLocalFiles(home, root, options);
  assert.deepEqual({ imported: second.imported, skipped: second.skipped, failed: second.failed }, { imported: 0, skipped: 2, failed: 0 });

  writeFileSync(join(root, "topics", "one.md"), "# One\n\nSecond version.\n");
  const third = syncLocalFiles(home, root, options);
  assert.equal(third.imported, 1);
  assert.equal(third.skipped, 1);
  assert.equal(readSourceRecords(home, third.results.find((result) => !result.skipped)!.source!.id)[0].content.includes("Second version"), true);
});
