import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSourceCoverage, writeSourceCoverage, type SourceTarget } from "../src/source-coverage.ts";
import type { Candidate, SourceRecord } from "../src/types.ts";

test("source coverage separates imported, content-empty and unresolved history inputs", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-coverage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const catpawDir = join(home, "staging", "catpaw-memory");
  mkdirSync(catpawDir, { recursive: true });
  writeFileSync(join(catpawDir, "latest.manifest.json"), `${JSON.stringify({ retrievedAt: "2026-08-06T00:00:00.000Z", totalCount: 42 })}\n`);
  const source = sourceRecord("src-covered", "codex", "/history/codex.jsonl", 3);
  const catpaw = sourceRecord("src-memory", "catpaw-memory", "/memory/latest.jsonl", 42);
  const targets: SourceTarget[] = [
    { id: "memory", adapter: "catpaw-memory", kind: "remote_memory", scope: "work", enabled: true },
    { id: "code", adapter: "federated-code-kb", kind: "query_time_federation", scope: "work", enabled: true },
  ];
  const candidate = {
    id: "cand-1", fingerprint: "work:citadel:1", kind: "citadel_document", status: "discovered", title: "Doc",
    scope: "work", sensitivity: "work-internal", locator: { adapter: "citadel", contentId: "1" },
    origin: { sourceIds: [], recordIds: [] }, resolution: null, nextAction: null, reason: null, revision: 1,
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  } satisfies Candidate;
  const report = buildSourceCoverage(home, {
    now: new Date("2026-08-07T00:00:00.000Z"),
    sources: [source, catpaw],
    candidates: [candidate],
    targets,
    historyCandidates: [
      history("codex", "/history/codex.jsonl"),
      history("claude", "/history/claude.jsonl"),
      history("desk", "/history/desk.jsonl"),
    ],
    incrementalStates: [{
      scanId: "scan-empty", logicalKey: "history:claude:/history/claude.jsonl", sourceId: null, previousSourceIds: [],
      originalPath: "/history/claude.jsonl", contentHash: "empty", scannedAt: "2026-08-06T12:00:00.000Z",
      status: "skipped", reason: "no-records", recordCount: 0, deltaCount: 0, duplicateCount: 0, changedCount: 0, cursor: null,
    }],
  });

  assert.deepEqual({ discovered: report.histories.discovered, covered: report.histories.covered, empty: report.histories.empty, backlog: report.histories.backlog }, { discovered: 3, covered: 1, empty: 1, backlog: 1 });
  assert.equal(report.citadel.pending, 1);
  assert.equal(report.targets.find((target) => target.id === "memory")?.coverageState, "covered");
  assert.equal(report.targets.find((target) => target.id === "code")?.coverageState, "federated");
  assert.equal(report.catpawMemory.totalCount, 42);
  assert.equal(report.stockComplete, false);

  const paths = writeSourceCoverage(home, report);
  assert.equal(existsSync(paths.jsonPath), true);
  assert.match(readFileSync(paths.markdownPath, "utf8"), /Agent 会话欠账：1/);
});

function history(adapter: "claude" | "codex" | "desk", path: string) {
  return { id: `hist-${adapter}`, adapter, kind: "ai_conversation" as const, path, title: adapter, scope: "work", sensitivity: "work-internal", size: 10, modifiedAt: "2026-08-06T00:00:00.000Z" };
}

function sourceRecord(id: string, adapter: string, originalPath: string, recordCount: number): SourceRecord {
  return {
    id, title: id, kind: adapter === "catpaw-memory" ? "manual" : "ai_conversation", adapter, includeTools: false,
    scope: "work", sensitivity: "work-internal", format: "jsonl", originalPath,
    rawPath: `/sources/${id}/raw/input.jsonl`, recordsPath: `/sources/${id}/records.jsonl`,
    contentHash: `${id}-content`, recordsHash: `${id}-records`, recordCount, importedAt: "2026-08-06T00:00:00.000Z",
  };
}
