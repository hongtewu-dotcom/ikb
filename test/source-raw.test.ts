import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactSourceRaw } from "../src/source-raw.ts";
import { importSourceRecords, inspectSourceIntegrity, listSources, parseSourceRecords } from "../src/source.ts";

test("raw compaction preserves every rawPath and shares append-only snapshots", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-raw-dedup-"));
  const input = join(home, "session.jsonl");
  const options = { kind: "ai_conversation" as const, adapter: "synthetic", scope: "work" as const };
  const firstContent = `${JSON.stringify({ session_id: "session", turn_id: "1", role: "user", content: "first" })}\n`;
  writeFileSync(input, firstContent);
  const firstId = "src-raw-first";
  const first = importSourceRecords(home, input, firstContent, options, parseSourceRecords(firstContent, firstId, options.kind, input), firstId).source;

  const secondContent = `${firstContent}${JSON.stringify({ session_id: "session", turn_id: "2", role: "assistant", content: "second" })}\n`;
  writeFileSync(input, secondContent);
  const secondId = "src-raw-second";
  const second = importSourceRecords(home, input, secondContent, options, parseSourceRecords(secondContent, secondId, options.kind, input), secondId).source;

  writeFileSync(input, secondContent);
  const exactId = "src-raw-exact";
  const exact = importSourceRecords(home, input, secondContent, options, parseSourceRecords(secondContent, exactId, options.kind, input), exactId).source;

  const result = compactSourceRaw(home);
  assert.equal(result.scannedSources, 3);
  assert.equal(result.issues.length, 0);
  assert.equal(result.prefixCompactedSources, 1);
  assert.equal(result.linkedSources, 1);
  assert.equal(existsSync(result.reportPath), true);
  assert.deepEqual(inspectSourceIntegrity(home, first), []);
  assert.deepEqual(inspectSourceIntegrity(home, second), []);
  assert.deepEqual(inspectSourceIntegrity(home, exact), []);
  assert.equal(readFileSync(first.rawPath, "utf8"), firstContent);
  assert.equal(readFileSync(second.rawPath, "utf8"), secondContent);
  assert.equal(readFileSync(exact.rawPath, "utf8"), secondContent);
  assert.equal(statSync(second.rawPath).size, Buffer.byteLength(secondContent));
  assert.equal(listSources(home, { includeQuarantined: true }).length, 3);

  const rerun = compactSourceRaw(home);
  assert.equal(rerun.issues.length, 0);
  assert.equal(rerun.prefixCompactedSources, 0);
  assert.equal(rerun.linkedSources, 0);
});
