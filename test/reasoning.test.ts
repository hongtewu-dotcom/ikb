import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureKnowledge, listKnowledge } from "../src/knowledge.ts";
import { runReasoning, readLatestReasoning } from "../src/reasoning.ts";
import { LedgerStore } from "../src/store.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-reasoning-test-"));
}

test("reasoning compresses low-risk, task evidence and high-risk questions without changing Knowledge", () => {
  const home = freshHome();
  const record = captureKnowledge(home, {
    title: "Reasoning classification fixture",
    type: "playbook",
    scope: "work",
    body: [
      "## 结论",
      "把证据和边界写成可复用的行动卡。",
      "",
      "## 待确认",
      "1. 确认事故数字只作案例，不作为线上阈值",
      "2. 当前最新版 SOP 和配置入口在哪里？",
      "3. 哪些配置变更必须先申请 Approval？",
      "4. 是否允许为这条规则自动创建 Issue？",
    ].join("\n"),
  });
  const store = new LedgerStore({ home, actor: "reasoning-test" });
  const report = runReasoning(home, store, { scope: "work", now: new Date("2026-07-21T00:00:00.000Z") });

  assert.equal(report.inputs.knowledgeActive, 1);
  assert.equal(report.summary.questionsExtracted, 4);
  assert.equal(report.summary.autoResolved, 1);
  assert.equal(report.summary.deferred, 1);
  assert.equal(report.summary.askUser, 2);
  assert.equal(report.decisionBundles.length, 1);
  assert.equal(report.decisionBundles[0].category, "policy");
  assert.equal(report.decisionBundles[0].itemCount, 2);
  assert.ok(existsSync(join(home, "governance", "work", "reasoning", "latest.json")));
  assert.ok(readLatestReasoning(home, "work"));
  assert.equal(listKnowledge(home, "work")[0].status, "draft");
  assert.equal(store.listEvents().filter((event) => event.eventType === "reasoning.generated").length, 1);

  const rerun = runReasoning(home, store, { scope: "work", now: new Date("2026-07-21T00:01:00.000Z") });
  assert.equal(rerun.id, report.id);
  assert.equal(store.listEvents().filter((event) => event.eventType === "reasoning.generated").length, 1);
  store.close();
  assert.equal(record.status, "draft");
});

test("reasoning gives policy and external side effects precedence over generic boundaries", () => {
  const home = freshHome();
  captureKnowledge(home, {
    title: "Boundary fixture",
    type: "playbook",
    scope: "work",
    body: [
      "## 待确认",
      "1. 哪些原则必须落为代码门禁？",
      "2. 是否允许生成本地证据清单？",
      "3. 是否允许发送评论到外部系统？",
      "4. 只用于跨域路由，不表示线上架构",
    ].join("\n"),
  });
  const store = new LedgerStore({ home });
  const report = runReasoning(home, store, { scope: "work" });
  const byText = new Map([...report.userDecisionQueue, ...report.autoResolved].map((question) => [question.text, question]));
  assert.equal(byText.get("哪些原则必须落为代码门禁？")?.disposition, "ask_user");
  assert.equal(byText.get("是否允许生成本地证据清单？")?.disposition, "auto_resolved");
  assert.equal(byText.get("是否允许发送评论到外部系统？")?.disposition, "ask_user");
  assert.equal(report.autoResolved.length, 2);
  assert.ok(report.autoResolved.some((question) => question.text.includes("本地证据清单")));
  assert.ok(report.autoResolved.some((question) => question.text.includes("跨域路由")));
  store.close();
});
