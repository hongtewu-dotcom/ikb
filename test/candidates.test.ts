import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addCandidate, discoverCitadelCandidates, inspectCandidatePool, listCandidates, updateCandidate } from "../src/candidates.ts";
import { importSourceRecords } from "../src/source.ts";
import { searchCitadel } from "../src/external.ts";
import { LedgerStore } from "../src/store.ts";

test("candidate pool is append-only, deduplicated and status-gated", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-candidate-home-"));
  const first = addCandidate(home, {
    kind: "citadel_document",
    title: "验价方案",
    scope: "work",
    locator: { adapter: "citadel", contentId: "123" },
    origin: { sourceIds: ["src-chat"], recordIds: ["src-chat:r1"] },
  });
  assert.equal(first.created, true);
  const duplicate = addCandidate(home, {
    kind: "citadel_document",
    title: "验价方案",
    scope: "work",
    locator: { adapter: "citadel", contentId: "123" },
    origin: { sourceIds: ["src-agent"], recordIds: ["src-agent:r2"] },
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.changed, true);
  assert.deepEqual(listCandidates(home)[0].origin.sourceIds, ["src-chat", "src-agent"]);
  assert.throws(() => updateCandidate(home, first.candidate.id, { status: "ingested" }), /requires resolved Source IDs/);
  const queued = updateCandidate(home, first.candidate.id, { status: "queued" });
  assert.equal(queued.status, "queued");
  const ingested = updateCandidate(home, first.candidate.id, { status: "ingested", resolution: { sourceIds: ["src-km"], ingestedAt: new Date().toISOString() } });
  assert.equal(ingested.status, "ingested");
  assert.equal(inspectCandidatePool(home).issues.length, 0);
});

test("source reference discovery turns Citadel links into traceable candidates", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-candidate-discover-home-"));
  const sourcePath = join(home, "agent.jsonl");
  writeFileSync(sourcePath, "{\"content\":\"open\"}\n");
  const source = importSourceRecords(home, sourcePath, "{\"content\":\"open\"}\n", {
    kind: "ai_conversation",
    adapter: "codex",
    scope: "work",
  }, [{
    id: "src-agent:conversation:r1",
    sourceId: "src-agent",
    conversationId: "conversation",
    role: "user",
    actor: "human",
    timestamp: "2026-07-17T00:00:00.000Z",
    content: "请读取 https://km.sankuai.com/page/123，并关注 contentId:456",
    refs: [],
    participants: ["human"],
  }], "src-agent").source;
  const result = discoverCitadelCandidates(home, source.id);
  assert.equal(result.foundLocators, 2);
  assert.equal(result.created, 2);
  assert.equal(result.createdIds.length, 2);
  const candidates = listCandidates(home, "work");
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.locator.contentId)), new Set(["123", "456"]));
  assert.equal(candidates.every((candidate) => candidate.origin.sourceIds.includes(source.id)), true);
  assert.equal(candidates.find((candidate) => candidate.locator.contentId === "123")?.locator.url, "https://km.sankuai.com/page/123");
});

test("Citadel search adapter preserves bounded request and normalizes result rows", () => {
  const calls: string[][] = [];
  const result = searchCitadel({
    keyword: "验价",
    searchTitle: true,
    offset: 20,
    limit: 10,
    spaceId: "27",
    runner: (_command, args) => {
      calls.push(args);
      return { data: [{ id: 123, title: "验价方案", summary: "摘要" }, { contentId: "456", name: "另一个文档", url: "https://km.sankuai.com/collabpage/456" }] };
    },
  });
  assert.deepEqual(calls[0], ["citadel", "searchContent", "--keyword", "验价", "--searchTitle", "--offset", "20", "--limit", "10", "--space-id", "27", "--raw"]);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].contentId, "123");
  assert.equal(result.hits[1].url, "https://km.sankuai.com/collabpage/456");
});

test("candidate events are visible in the ledger", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-candidate-ledger-home-"));
  const store = new LedgerStore({ home, actor: "test" });
  const result = addCandidate(home, {
    kind: "external",
    title: "manual input",
    scope: "personal",
    locator: { adapter: "manual", query: "remember this" },
  });
  store.recordCandidateEvent(result.candidate.id, "candidate.discovered", { candidate: result.candidate });
  assert.equal(store.listEvents().filter((event) => event.aggregateType === "candidate").length, 1);
  assert.equal(store.verify().brokenChains.length, 0);
  store.close();
});
