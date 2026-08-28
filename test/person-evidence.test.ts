import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPersonReadiness, recordPersonAnalysisCheckpoint, writePersonEvidenceSnapshot } from "../src/person-evidence.ts";

test("person evidence readiness queues semantic analysis without claiming knowledge admission", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-person-evidence-"));
  const input = {
    personId: "alice",
    name: "Alice",
    scope: "work" as const,
    generatedAt: "2026-08-07T00:00:00.000Z",
    matchedCount: 8,
    directMatchedCount: 5,
    contextMatchedCount: 3,
    directEpisodeKeys: ["episode-1", "episode-2", "episode-3"],
    independentSourceKeys: ["source-1", "source-2"],
    distinctDates: ["2026-08-01", "2026-08-02"],
    sourceKinds: ["document", "elephant"],
    sourceIds: ["src-1", "src-2"],
    attributionCounts: { speaker: 3, author: 0, creator: 1, owner: 1, modifier: 0, record_actor: 0, context: 3 },
  };
  const first = writePersonEvidenceSnapshot(home, input);
  const readiness = buildPersonReadiness(home, { scope: "work", mode: "weekly", now: new Date("2026-08-07T01:00:00.000Z") });
  assert.equal(readiness.people[0].state, "analysis_due");
  assert.equal(readiness.people[0].knowledgeAdmissionReady, false);
  assert.match(readiness.people[0].nextAction, /语义聚类.*反证/u);

  const artifact = join(home, "alice-analysis.md");
  writeFileSync(artifact, "# Alice analysis\n\nNo stable candidate.\n");
  recordPersonAnalysisCheckpoint(home, "alice", { scope: "work", artifactPath: artifact, disposition: "evidence_only", counterevidenceSearch: "2026-08-01 至 2026-08-07 全部直接 Episode" });
  const unchanged = buildPersonReadiness(home, { scope: "work", mode: "weekly", now: new Date("2026-08-08T01:00:00.000Z") });
  assert.equal(unchanged.people[0].state, "up_to_date");

  writePersonEvidenceSnapshot(home, {
    ...input,
    generatedAt: "2026-08-08T02:00:00.000Z",
    directEpisodeKeys: [...input.directEpisodeKeys, "episode-4", "episode-5", "episode-6"],
    independentSourceKeys: [...input.independentSourceKeys, "source-3", "source-4"],
    distinctDates: [...input.distinctDates, "2026-08-08"],
    sourceIds: [...input.sourceIds, "src-3", "src-4"],
  });
  const changed = buildPersonReadiness(home, { scope: "work", mode: "incremental", now: new Date("2026-08-08T03:00:00.000Z") });
  assert.equal(changed.people[0].state, "analysis_due");
  assert.equal(changed.people[0].newDirectEpisodes, 3);
  assert.equal(changed.people[0].newIndependentSources, 2);
  assert.equal(first.fingerprint.length, 64);
});

test("person evidence fingerprint ignores rebuild time when evidence is unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-person-stable-fingerprint-"));
  const input = {
    personId: "alice",
    name: "Alice",
    scope: "work" as const,
    generatedAt: "2026-08-07T00:00:00.000Z",
    matchedCount: 3,
    directMatchedCount: 3,
    contextMatchedCount: 0,
    directEpisodeKeys: ["episode-1", "episode-2", "episode-3"],
    independentSourceKeys: ["source-1", "source-2"],
    distinctDates: ["2026-08-01", "2026-08-02"],
    sourceKinds: ["document", "elephant"],
    sourceIds: ["src-1", "src-2"],
    attributionCounts: { speaker: 2, author: 0, creator: 1, owner: 0, modifier: 0, record_actor: 0, context: 0 },
  };
  const first = writePersonEvidenceSnapshot(home, input);
  const second = writePersonEvidenceSnapshot(home, { ...input, generatedAt: "2026-08-08T00:00:00.000Z" });
  assert.equal(second.generatedAt, "2026-08-08T00:00:00.000Z");
  assert.equal(second.fingerprint, first.fingerprint);
  const history = readFileSync(join(home, "governance", "work", "people", "evidence", "alice", "history.jsonl"), "utf8").trim().split("\n");
  assert.equal(history.length, 1);
});
