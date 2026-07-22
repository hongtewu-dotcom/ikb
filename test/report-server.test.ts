import assert from "node:assert/strict";
import test from "node:test";
import { renderReportHtml } from "../scripts/ikb-report-server.mjs";

test("live report serves a local, no-store HTML shell", () => {
  const html = renderReportHtml();
  assert.match(html, /IKB 运行观测/);
  assert.match(html, /fetch\('\/api\/report\?ts=/);
  assert.match(html, /setInterval\(load, 15000\)/);
  assert.match(html, /本地只读观测/);
  assert.doesNotMatch(html, /127\.0\.0\.1:5173/);
  assert.match(html, /不含 Source\/Knowledge 正文/);
  assert.match(html, /Experience 分析队列/);
  assert.match(html, /Knowledge Candidate 待复核/);
  assert.match(html, /全局推理与确认项/);
  assert.match(html, /推理待确认/);
});
