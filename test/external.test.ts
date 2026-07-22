import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEPHANT_READ_ONLY_OPERATION, ingestCitadelDocument, ingestElephantHistory } from "../src/external.ts";
import { listSources, readSourceRecords } from "../src/source.ts";

test("Citadel intake preserves document metadata, discussion comments and replies", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-citadel-home-"));
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("getSimpleMarkdown")) return { contentId: "123", title: "Synthetic KM", content: "# Synthetic KM\n\nDocument evidence." };
    if (args.includes("getDocumentMetaInfo")) return { contentId: "123", title: "Synthetic KM", creator: "author", modifier: "reviewer", modifyTime: 1780000000000 };
    if (args.includes("getAllComments")) return {
      contentId: "123",
      discussionComments: [{ commentId: "c1", quoteId: "q1", quoteContent: "a paragraph", content: "Please add evidence.", creator: "reviewer", createTime: 1780000001000, resolved: false, replies: [{ commentId: "c2", content: "Added in the draft.", creator: "author", createTime: 1780000002000, resolved: true }] }],
      fullTextComments: [{ commentId: "c3", content: "Looks good after the update.", creator: "reviewer", createTime: 1780000003000, resolved: true }],
    };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  const first = ingestCitadelDocument(home, "123", { scope: "work", runner });
  assert.equal(first.title, "Synthetic KM");
  assert.equal(first.document.imported, true);
  assert.equal(first.comments?.count, 3);
  assert.equal(first.comments?.imported, true);
  const sources = listSources(home);
  assert.equal(sources.length, 2);
  const documentSource = sources.find((source) => source.kind === "document");
  const commentSource = sources.find((source) => source.kind === "review_comment");
  assert.ok(documentSource);
  assert.ok(commentSource);
  const documentRecord = readSourceRecords(home, documentSource.id)[0];
  assert.equal(documentRecord?.actor, "reviewer");
  assert.deepEqual(documentRecord?.participants, ["author", "reviewer"]);
  assert.equal(documentRecord?.refs.includes("creator:author"), true);
  assert.equal(documentRecord?.refs.includes("modifier:reviewer"), true);
  const comments = readSourceRecords(home, commentSource.id);
  assert.deepEqual(comments.map((record) => record.role), ["review_comment", "review_reply", "review_comment"]);
  assert.match(comments[0]?.content ?? "", /引用：a paragraph/);
  assert.equal(comments[1]?.refs.some((ref) => ref === "parentCommentId:c1"), true);
  assert.equal(comments.every((record) => record.sourceId === commentSource.id), true);

  const second = ingestCitadelDocument(home, "123", { scope: "work", runner });
  assert.equal(second.document.source.id, first.document.source.id);
  assert.equal(second.document.imported, false);
  assert.equal(second.comments?.source.id, first.comments?.source.id);
  assert.equal(second.comments?.imported, false);
  assert.equal(calls.filter((args) => args.includes("getAllComments")).length, 2);
});

test("Elephant intake calls the local dx history bridge, keeps raw evidence and deduplicates", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-elephant-bridge-home-"));
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]) => {
    calls.push(args);
    return {
      traceId: `trace-${calls.length}`,
      ok: true,
      source: "runtime_history",
      returned: 2,
      messages: [
        { id: "m1", name: "person-a", timestamp: 1784167200000, text: "", raw: { from: "uid-a", mid: "mid-1", uuid: "uuid-1", data: JSON.stringify({ nodes: [{ t: "at", name: "@person-b" }, { t: "text", c: " Record the decision." }] }) }, participants: ["person-a", "person-b"] },
        { id: "m2", name: "person-b", time: "2026-07-16 10:01:00", content: "Agreed.", participants: ["person-a", "person-b"] },
      ],
    };
  };

  const first = ingestElephantHistory(home, { gid: "g-1", type: "group", keyword: "decision", limit: 2, scope: "work", runner });
  assert.equal(first.operation, ELEPHANT_READ_ONLY_OPERATION);
  assert.equal(first.readOnly, true);
  assert.equal(first.imported, true);
  assert.equal(first.recordCount, 2);
  assert.ok(first.source);
  assert.equal(first.source.kind, "elephant");
  assert.equal(first.source.adapter, "elephant");
  assert.equal(readSourceRecords(home, first.source.id)[0]?.actor, "person-a");
  assert.equal(readSourceRecords(home, first.source.id)[0]?.participants.length, 2);
  assert.match(readSourceRecords(home, first.source.id)[0]?.content ?? "", /@person-b Record the decision/);
  assert.equal(readSourceRecords(home, first.source.id)[0]?.refs.includes("mid:mid-1"), true);
  assert.equal(readSourceRecords(home, first.source.id)[0]?.refs.includes("senderUid:uid-a"), true);
  assert.match(readFileSync(first.source.rawPath, "utf8"), /runtime_history/);
  assert.deepEqual(calls[0], ["--json", "history", "--gid", "g-1", "--limit", "2", "--raw-payload", "--type", "group", "--keyword", "decision"]);
  assert.equal(calls[0].some((arg) => /^(send|reply|forward|like|react|create|update|delete)$/.test(arg)), false);

  const second = ingestElephantHistory(home, { gid: "g-1", type: "group", keyword: "decision", limit: 2, scope: "work", runner });
  assert.equal(second.imported, false);
  assert.equal(second.skipped, true);
  assert.equal(second.source?.id, first.source.id);
  assert.equal(listSources(home).length, 1);
});
