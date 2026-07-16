import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSourceContext, importSource, listSources, readSourceRecords } from "../src/source.ts";

test("source ingest normalizes AI conversation JSONL and builds cited context", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-ai-test-"));
  const input = join(home, "codex.jsonl");
  writeFileSync(input, [
    JSON.stringify({ session_id: "sess-1", turn_id: "1", role: "user", content: "Review the pricing design", timestamp: "2026-07-16T01:00:00Z", files: ["design.md"] }),
    JSON.stringify({ session_id: "sess-1", turn_id: "2", role: "assistant", content: "The source must be retained.", timestamp: "2026-07-16T01:01:00Z", refs: ["run-1"] }),
  ].join("\n") + "\n");

  const result = importSource(home, input, { kind: "ai_conversation", scope: "work", title: "Codex pricing session" });
  assert.equal(result.source.kind, "ai_conversation");
  assert.equal(result.source.recordCount, 2);
  assert.equal(readSourceRecords(home, result.source.id)[1].refs[0], "run-1");
  assert.equal(listSources(home)[0].id, result.source.id);
  const context = buildSourceContext(home, result.source.id);
  assert.match(context.markdown, /Review the pricing design/);
  assert.match(context.markdown, /design\.md/);
  assert.match(readFileSync(result.source.rawPath, "utf8"), /source must be retained/);
});

test("source ingest treats important documents and review comments as cited records", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-document-test-"));
  const input = join(home, "review.md");
  writeFileSync(input, "# CR comment\n\nPlease add the failure evidence and explain why this path is safe.\n");
  const result = importSource(home, input, { kind: "review_comment", scope: "work" });
  const record = readSourceRecords(home, result.source.id)[0];
  assert.equal(record.role, "review_comment");
  assert.deepEqual(record.refs, [input]);
  assert.match(buildSourceContext(home, result.source.id).markdown, /failure evidence/);
});
