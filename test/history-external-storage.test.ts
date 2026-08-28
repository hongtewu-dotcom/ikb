import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { externalizeHistoryRaw } from "../src/source-raw.ts";
import { importHistoryCandidate, type HistoryCandidate } from "../src/history.ts";
import { importSourceRecords, inspectSourceIntegrity, listSources, readSourceRecords } from "../src/source.ts";
import type { SourceMessage, SourceRecord } from "../src/types.ts";

function candidate(path: string): HistoryCandidate {
  const file = statSync(path);
  return {
    id: "hist-external-test",
    adapter: "codex",
    kind: "ai_conversation",
    path,
    title: "codex: external storage test",
    scope: "work",
    sensitivity: "work-internal",
    size: file.size,
    modifiedAt: file.mtime.toISOString(),
  };
}

function codexLine(type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
}

test("Codex history keeps one external original and only stores normalized evidence", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-history-external-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "rollout.jsonl");
  mkdirSync(home, { recursive: true });
  writeFileSync(input, [
    codexLine("session_meta", { id: "session-1", cwd: sandbox }),
    codexLine("compacted", { message: "x".repeat(512 * 1024), replacement_history: [] }),
    codexLine("event_msg", { type: "user_message", message: "first question" }),
    codexLine("event_msg", { type: "agent_message", message: "first answer" }),
  ].join(""));

  const first = importHistoryCandidate(home, candidate(input), { scope: "work", incremental: true });
  assert.equal(first.error, undefined);
  assert.equal(first.source?.rawStorage, "external");
  assert.equal(first.source?.rawPath, input);
  assert.equal(first.source?.recordCount, 2);
  assert.equal(first.readBytes, statSync(input).size);
  assert.equal(statSync(first.source!.recordsPath).size < statSync(input).size / 10, true);
  assert.deepEqual(inspectSourceIntegrity(home, first.source!), []);

  const appended = codexLine("event_msg", { type: "user_message", message: "second question" });
  appendFileSync(input, appended);
  const second = importHistoryCandidate(home, candidate(input), { scope: "work", incremental: true });
  assert.equal(second.error, undefined);
  assert.equal(second.deltaCount, 1);
  assert.equal(second.source?.rawStorage, "external");
  assert.equal(second.source?.rawPath, input);
  assert.equal(second.readBytes, Buffer.byteLength(appended));
  assert.equal(readSourceRecords(home, second.source!.id).at(0)?.content, "second question");
  assert.deepEqual(inspectSourceIntegrity(home, second.source!), []);
});

test("legacy local history raw copies are deleted only after normalized evidence passes integrity", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-history-migrate-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "rollout.jsonl");
  mkdirSync(home, { recursive: true });
  const content = `${JSON.stringify({ role: "user", content: "durable evidence" })}\n`;
  writeFileSync(input, content);
  const sourceId = "src-history-legacy";
  const records: SourceMessage[] = [{
    id: `${sourceId}:line-1:1`,
    sourceId,
    conversationId: "session-legacy",
    role: "user",
    actor: "user",
    timestamp: "2026-08-13T00:00:00.000Z",
    content: "durable evidence",
    refs: [input],
    participants: ["user", "assistant"],
  }];
  const legacy = importSourceRecords(home, input, content, {
    kind: "ai_conversation",
    adapter: "codex",
    scope: "work",
    sensitivity: "work-internal",
  }, records, sourceId).source;
  const legacyRawPath = legacy.rawPath;
  assert.equal(existsSync(legacyRawPath), true);

  const migratedEvents: SourceRecord[] = [];
  const result = externalizeHistoryRaw(home, { onMigrated: (source) => migratedEvents.push(source) });
  assert.equal(result.migratedSources, 1);
  assert.equal(result.removedBytes, Buffer.byteLength(content));
  assert.equal(result.issues.length, 0);
  assert.equal(existsSync(legacyRawPath), false);
  assert.equal(migratedEvents.length, 1);

  const migrated = listSources(home, { includeQuarantined: true }).find((source) => source.id === sourceId)!;
  assert.equal(migrated.rawStorage, "external");
  assert.equal(migrated.rawPath, input);
  assert.equal(migrated.originalPath, input);
  assert.equal(dirname(migrated.recordsPath).endsWith(sourceId), true);
  assert.equal(readSourceRecords(home, sourceId).at(0)?.content, "durable evidence");
  assert.deepEqual(inspectSourceIntegrity(home, migrated), []);

  const rerun = externalizeHistoryRaw(home);
  assert.equal(rerun.migratedSources, 0);
  assert.equal(rerun.removedBytes, 0);
});

test("missing owner history becomes evidence-only and backfills a legacy records hash", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-history-evidence-only-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "deleted-rollout.jsonl");
  mkdirSync(home, { recursive: true });
  const content = `${JSON.stringify({ role: "user", content: "only normalized evidence remains" })}\n`;
  writeFileSync(input, content);
  const sourceId = "src-history-evidence-only";
  const records: SourceMessage[] = [{
    id: `${sourceId}:line-1:1`,
    sourceId,
    conversationId: "session-deleted",
    role: "user",
    actor: "user",
    timestamp: "2026-08-13T00:00:00.000Z",
    content: "only normalized evidence remains",
    refs: [input],
    participants: ["user", "assistant"],
  }];
  const source = importSourceRecords(home, input, content, {
    kind: "ai_conversation",
    adapter: "codex",
    scope: "work",
    sensitivity: "work-internal",
  }, records, sourceId).source;
  const managedRawPath = source.rawPath;
  const metadataPath = join(dirname(source.recordsPath), "source.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  delete metadata.recordsHash;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  unlinkSync(input);

  const result = externalizeHistoryRaw(home);
  assert.equal(result.migratedSources, 1);
  assert.equal(result.externalSources, 0);
  assert.equal(result.evidenceOnlySources, 1);
  assert.equal(result.issues.length, 0);
  assert.equal(existsSync(managedRawPath), false);

  const migrated = listSources(home, { includeQuarantined: true }).find((item) => item.id === sourceId)!;
  assert.equal(migrated.rawStorage, "evidence");
  assert.equal(migrated.rawPath, migrated.recordsPath);
  assert.equal(typeof migrated.recordsHash, "string");
  assert.equal(readSourceRecords(home, sourceId).at(0)?.content, "only normalized evidence remains");
  assert.deepEqual(inspectSourceIntegrity(home, migrated), []);
});
