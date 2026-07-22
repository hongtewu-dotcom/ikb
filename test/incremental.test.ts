import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importIncrementalRecords } from "../src/incremental.ts";
import { ingestCitadelDocument, ingestElephantHistory } from "../src/external.ts";
import { ingestHistory } from "../src/history.ts";
import { parseSourceRecords, readSourceRecords, listSources } from "../src/source.ts";

test("generic JSONL input imports only new and changed records", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-incremental-jsonl-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "messages.jsonl");
  const write = (rows: unknown[]) => writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const importCurrent = () => {
    const content = readFileSync(input);
    const sourceId = `src-current-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return importIncrementalRecords(home, input, content, {
      kind: "ai_conversation",
      adapter: "synthetic",
      scope: "work",
      logicalKey: "synthetic:session-1",
    }, parseSourceRecords(content.toString("utf8"), sourceId, "ai_conversation", input));
  };

  write([
    { conversation_id: "session-1", id: "m1", role: "user", content: "first" },
    { conversation_id: "session-1", id: "m2", role: "assistant", content: "second" },
  ]);
  const first = importCurrent();
  assert.equal(first.imported, true);
  assert.equal(first.deltaCount, 2);
  assert.equal(first.duplicateCount, 0);

  write([
    { conversation_id: "session-1", id: "m1", role: "user", content: "first" },
    { conversation_id: "session-1", id: "m2", role: "assistant", content: "second revised" },
    { conversation_id: "session-1", id: "m3", role: "user", content: "third" },
  ]);
  const second = importCurrent();
  assert.equal(second.imported, true);
  assert.equal(second.deltaCount, 2);
  assert.equal(second.changedCount, 1);
  assert.equal(second.duplicateCount, 1);
  assert.deepEqual(readSourceRecords(home, second.source!.id).map((record) => record.content), ["second revised", "third"]);

  const third = importCurrent();
  assert.equal(third.imported, false);
  assert.equal(third.reason, "unchanged");
  assert.equal(listSources(home).length, 2);
  const state = readFileSync(join(home, "governance", "work", "incremental", "state.jsonl"), "utf8");
  assert.equal(state.trim().split("\n").length, 3);
});

test("history adapter uses the same incremental contract for appended sessions", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-incremental-history-"));
  const home = join(sandbox, "ikb-data");
  const root = join(sandbox, "claude");
  const input = join(root, "session.jsonl");
  mkdirSync(root, { recursive: true });
  const write = (rows: unknown[]) => writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  write([{ type: "user", sessionId: "s1", uuid: "u1", message: { content: "first" } }]);
  const first = ingestHistory(home, "claude", { root, scope: "work", limit: 0 });
  assert.equal(first.incremental, true);
  assert.equal(first.results[0].deltaCount, 1);

  write([
    { type: "user", sessionId: "s1", uuid: "u1", message: { content: "first" } },
    { type: "assistant", sessionId: "s1", uuid: "a1", message: { content: "second" } },
  ]);
  const second = ingestHistory(home, "claude", { root, scope: "work", limit: 0 });
  assert.equal(second.imported, 1);
  assert.equal(second.results[0].deltaCount, 1);
  assert.equal(readSourceRecords(home, second.results[0].source!.id).length, 1);
  assert.equal(readSourceRecords(home, second.results[0].source!.id)[0].content, "second");
});

test("Citadel and Elephant adapters append only new comments/messages", () => {
  const citadelHome = mkdtempSync(join(tmpdir(), "ikb-incremental-citadel-"));
  let commentRound = 0;
  const citadelRunner = (_command: string, args: string[]) => {
    if (args.includes("getSimpleMarkdown")) return { contentId: "123", title: "Synthetic", content: "# Stable document" };
    if (args.includes("getDocumentMetaInfo")) return { contentId: "123", modifier: "reviewer", modifyTime: 1780000000000 };
    commentRound += 1;
    return {
      contentId: "123",
      discussionComments: [{ commentId: "c1", content: "first", creator: "reviewer" }, ...(commentRound > 1 ? [{ commentId: "c2", content: "second", creator: "author" }] : [])],
      fullTextComments: [],
    };
  };
  const citadelFirst = ingestCitadelDocument(citadelHome, "123", { scope: "work", runner: citadelRunner });
  const citadelSecond = ingestCitadelDocument(citadelHome, "123", { scope: "work", runner: citadelRunner });
  assert.equal(citadelFirst.comments?.count, 1);
  assert.equal(citadelSecond.comments?.count, 2);
  assert.equal(citadelSecond.comments?.imported, true);
  assert.deepEqual(readSourceRecords(citadelHome, citadelSecond.comments!.source.id).map((record) => record.content), ["评论：second"]);

  const elephantHome = mkdtempSync(join(tmpdir(), "ikb-incremental-elephant-"));
  let messageRound = 0;
  const elephantRunner = () => {
    messageRound += 1;
    return { messages: [{ id: "m1", name: "person-a", text: "first" }, ...(messageRound > 1 ? [{ id: "m2", name: "person-b", text: "second" }] : [])] };
  };
  const elephantFirst = ingestElephantHistory(elephantHome, { gid: "g1", type: "group", scope: "work", runner: elephantRunner });
  const elephantSecond = ingestElephantHistory(elephantHome, { gid: "g1", type: "group", scope: "work", runner: elephantRunner });
  assert.equal(elephantFirst.deltaCount, 1);
  assert.equal(elephantSecond.deltaCount, 1);
  assert.equal(readSourceRecords(elephantHome, elephantSecond.source!.id).length, 1);
});
