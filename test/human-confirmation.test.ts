import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveResolvedHumanConfirmationFiles, HUMAN_CONFIRMATION_BRIEF_SCHEMA, writeHumanConfirmationBrief, type HumanConfirmationBriefItem } from "../src/human-confirmation.ts";

function item(key: string): HumanConfirmationBriefItem {
  return {
    key,
    title: `确认项 ${key}`,
    content: `这是 ${key} 的完整、供人阅读的确认内容。`,
    triggers: [`触发 ${key}`],
    boundaries: [`边界 ${key}`],
    retirementSignals: [`退役 ${key}`],
    confirmEffect: `确认 ${key} 后采用这项提议。`,
    rejectEffect: `驳回 ${key} 后不采用这项提议。`,
    proposalPath: `proposals/${key}.md`,
    proposalHash: key.repeat(16).slice(0, 64),
    sourceRefs: [`source://${key}`],
  };
}

test("writes three confirmation items as one content-first Markdown brief", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-human-confirmation-"));
  const result = writeHumanConfirmationBrief(home, {
    id: "principles.2026-08-27",
    scope: "work",
    title: "三项原则人工确认稿",
    purpose: "请判断这三项原则是否应被逐项确认。",
    items: [item("alpha"), item("beta"), item("gamma")],
  });
  const text = readFileSync(result.path, "utf8");
  assert.equal(result.schema, HUMAN_CONFIRMATION_BRIEF_SCHEMA);
  assert.equal(result.itemCount, 3);
  assert.equal((text.match(/^## (?:alpha|beta|gamma)\. 确认项 /gm) ?? []).length, 3);
  assert.ok(text.indexOf("这是 gamma 的完整、供人阅读的确认内容。") < text.indexOf("## 机器审计附录"));
  assert.ok(text.includes("确认 alpha 后采用这项提议。"));
  assert.ok(text.includes("驳回 beta 后不采用这项提议。"));
  assert.ok(text.includes("确认：alpha、beta、gamma"));
  const appendix = text.indexOf("## 机器审计附录");
  assert.ok(appendix > 0);
  assert.equal(text.slice(0, appendix).includes("source://alpha"), false);
  assert.equal(text.slice(0, appendix).includes("Proposal hash:"), false);
  assert.ok(text.slice(appendix).includes("source://alpha"));
  assert.ok(text.slice(appendix).includes("Proposal hash:"));
});

test("is idempotent for exact content and rejects a conflicting overwrite", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-human-confirmation-"));
  const input = { id: "same-id", scope: "personal" as const, title: "确认", purpose: "确认一项内容。", items: [item("same")] };
  const first = writeHumanConfirmationBrief(home, input);
  const second = writeHumanConfirmationBrief(home, input);
  assert.equal(second.path, first.path);
  assert.equal(second.contentHash, first.contentHash);
  assert.throws(() => writeHumanConfirmationBrief(home, { ...input, purpose: "变更后的内容。" }), /already exists with different content/);
});

test("rejects unsafe ids", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-human-confirmation-"));
  assert.throws(() => writeHumanConfirmationBrief(home, {
    id: "../escape",
    scope: "personal",
    title: "确认",
    purpose: "确认一项内容。",
    items: [item("safe")],
  }), /Invalid human confirmation brief id/);
});

test("archives only terminal or invalid Candidate confirmation history", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-human-confirmation-archive-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, "inbox", "work", "confirmations");
  mkdirSync(directory, { recursive: true });
  const files = {
    "candidate-terminal.md": "Candidate: experience-candidate:exp-cand-terminal\n",
    "candidate-pending.md": "Candidate: experience-candidate:exp-cand-pending\n",
    "candidate-invalid.md": "# Legacy candidate page without an auditable binding\n",
    "semantic-maintenance-current.md": "# Current non-Candidate decision brief\n",
    "historical.json": "{\"legacy\":true}\n",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);

  const archived = archiveResolvedHumanConfirmationFiles(home, "work", new Map([
    ["exp-cand-terminal", "applied"],
    ["exp-cand-pending", "pending_review"],
  ]));

  assert.deepEqual(archived.map((item) => [item.name, item.reason]).sort(), [
    ["candidate-invalid.md", "invalid_candidate_brief"],
    ["candidate-terminal.md", "resolved_candidate"],
    ["historical.json", "historical_json"],
  ]);
  assert.equal(existsSync(join(directory, "candidate-pending.md")), true);
  assert.equal(existsSync(join(directory, "semantic-maintenance-current.md")), true);
  for (const name of ["candidate-invalid.md", "candidate-terminal.md", "historical.json"]) {
    assert.equal(existsSync(join(directory, name)), false);
    assert.equal(readFileSync(join(home, "archive", "inbox", "work", "confirmations", name), "utf8"), files[name as keyof typeof files]);
  }
});
