import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addKeyPerson } from "../src/people.ts";
import { buildElephantPersonView, writePersonDossier } from "../src/person.ts";
import { importSourceRecords } from "../src/source.ts";
import type { SourceMessage } from "../src/types.ts";

test("Elephant person view filters by actor and keeps cited context", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-view-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "group.jsonl");
  const content = "{\"id\":\"m1\",\"content\":\"first\"}\n{\"id\":\"m2\",\"content\":\"second\"}\n{\"id\":\"m3\",\"content\":\"third\"}\n";
  writeFileSync(input, content);
  const sourceId = "src-person-view";
  const records: SourceMessage[] = [
    { id: `${sourceId}:m1`, sourceId, conversationId: "gid:g1", role: "human", actor: "李四", timestamp: "2026-07-16T00:00:00.000Z", content: "first", refs: ["senderUid:u2"], participants: ["李四", "张三"] },
    { id: `${sourceId}:m2`, sourceId, conversationId: "gid:g1", role: "human", actor: "张三", timestamp: "2026-07-16T00:01:00.000Z", content: "second", refs: ["senderUid:u1"], participants: ["李四", "张三"] },
    { id: `${sourceId}:m3`, sourceId, conversationId: "gid:g1", role: "human", actor: "王五", timestamp: "2026-07-16T00:02:00.000Z", content: "third", refs: ["senderUid:u3"], participants: ["李四", "张三", "王五"] },
  ];
  importSourceRecords(home, input, content, { kind: "elephant", adapter: "elephant", scope: "work", title: "项目群" }, records, sourceId);
  const duplicateSourceId = "src-person-view-2";
  importSourceRecords(home, input, content, { kind: "elephant", adapter: "elephant", scope: "work", title: "项目群旧快照" }, records.map((record) => ({ ...record, id: record.id.replace(sourceId, duplicateSourceId), sourceId: duplicateSourceId })), duplicateSourceId);

  const byName = buildElephantPersonView(home, { name: "张三", contextWindow: 1, scope: "work" });
  assert.equal(byName.sourceCount, 2);
  assert.equal(byName.scannedRecordCount, 6);
  assert.equal(byName.matchedCount, 1);
  assert.equal(byName.duplicateCount, 1);
  assert.equal(byName.matches[0]?.record.content, "second");
  assert.deepEqual(byName.matches[0]?.context.map((record) => record.content), ["first", "second", "third"]);

  const byUid = buildElephantPersonView(home, { uid: "u1", contextWindow: 0, from: "2026-07-16", to: "2026-07-16" });
  assert.equal(byUid.matchedCount, 1);
  assert.match(byUid.matches[0]?.record.id ?? "", /:m2$/);
  assert.equal(byUid.matches[0]?.context.length, 1);
});

test("Elephant person view requires an explicit speaker selector", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-person-selector-"));
  assert.throws(() => buildElephantPersonView(home), /exactly one/);
  assert.throws(() => buildElephantPersonView(home, { name: "a", uid: "u1" }), /exactly one/);
});

test("person dossier aggregates Citadel, review, Elephant and Agent evidence without crossing scope", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-dossier-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "source.jsonl");
  writeFileSync(input, "synthetic\n");
  addKeyPerson(home, "alice", { mis: "alice", name: "Alice", aliases: ["A"], scope: "work" });

  const addSource = (sourceId: string, kind: string, title: string, records: SourceMessage[], scope = "work") => importSourceRecords(
    home,
    input,
    `${sourceId}\n`,
    { kind, adapter: kind === "document" || kind === "review_comment" ? "citadel" : kind === "elephant" ? "elephant" : "codex", scope, title },
    records,
    sourceId,
  );
  addSource("src-dossier-doc", "document", "KM 方案", [{ id: "src-dossier-doc:doc", sourceId: "src-dossier-doc", conversationId: "citadel:km-1", role: "document", actor: "Alice", timestamp: "2026-07-16T01:00:00Z", content: "Alice authored this document.", refs: ["contentId:km-1", "creator:alice"], participants: ["Alice"] }]);
  addSource("src-dossier-comment", "review_comment", "KM 方案 - 评论", [{ id: "src-dossier-comment:c1", sourceId: "src-dossier-comment", conversationId: "citadel:km-1:comment:c1", role: "review_comment", actor: "Alice", timestamp: "2026-07-16T02:00:00Z", content: "Please keep the evidence.", refs: ["contentId:km-1", "commentId:c1"], participants: ["Alice"] }]);
  const elephantRecords: SourceMessage[] = [{ id: "src-dossier-elephant:m1", sourceId: "src-dossier-elephant", conversationId: "gid:g1", role: "human", actor: "Alice", timestamp: "2026-07-16T03:00:00Z", content: "Decision in Elephant.", refs: ["messageId:m1", "senderMis:alice"], participants: ["Alice", "Bob"] }];
  addSource("src-dossier-elephant", "elephant", "大象群", elephantRecords);
  addSource("src-dossier-elephant-copy", "elephant", "大象群旧快照", elephantRecords.map((record) => ({ ...record, id: record.id.replace("src-dossier-elephant", "src-dossier-elephant-copy"), sourceId: "src-dossier-elephant-copy" })));
  addSource("src-dossier-agent", "ai_conversation", "Codex 会话", [{ id: "src-dossier-agent:a1", sourceId: "src-dossier-agent", conversationId: "codex:c1", role: "assistant", actor: "assistant", timestamp: "2026-07-16T04:00:00Z", content: "The agent recorded Alice's decision.", refs: ["personId:alice"], participants: ["Alice", "assistant"] }]);
  addSource("src-dossier-personal", "document", "Personal note", [{ id: "src-dossier-personal:p1", sourceId: "src-dossier-personal", conversationId: "personal:p1", role: "document", actor: "Alice", timestamp: "2026-07-16T05:00:00Z", content: "Must not cross scope.", refs: ["creator:alice"], participants: ["Alice"] }], "personal");

  const dossier = writePersonDossier(home, "alice", { limit: 20 });
  assert.equal(dossier.scope, "work");
  assert.equal(dossier.sourceCount, 5);
  assert.equal(dossier.matchedSourceCount, 5);
  assert.equal(dossier.matchedCount, 4);
  assert.equal(dossier.directMatchedCount, 3);
  assert.equal(dossier.contextMatchedCount, 1);
  assert.equal(dossier.duplicateCount, 1);
  assert.deepEqual(new Set(dossier.entries.map((entry) => entry.sourceKind)), new Set(["document", "review_comment", "elephant", "ai_conversation"]));
  assert.equal(existsSync(dossier.path), true);
  const markdown = readFileSync(dossier.path, "utf8");
  assert.match(markdown, /KM 方案/);
  assert.match(markdown, /Please keep the evidence/);
  assert.match(markdown, /src-dossier-agent/);
  assert.doesNotMatch(markdown, /Must not cross scope/);
});
