import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboardReport } from "../src/dashboard.ts";
import { runReasoning } from "../src/reasoning.ts";
import { LedgerStore } from "../src/store.ts";

test("dashboard keeps a valid scope visible when another reasoning snapshot is stale", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-dashboard-"));
  const store = new LedgerStore({ home });
  const work = runReasoning(home, store, { scope: "work", now: new Date("2026-08-07T00:00:00Z") });
  const personalDirectory = join(home, "governance", "personal", "reasoning");
  mkdirSync(personalDirectory, { recursive: true });
  writeFileSync(join(personalDirectory, "latest.json"), `${JSON.stringify({ schema: "ikb-reasoning.v1", id: "legacy" })}\n`);

  const report = buildDashboardReport(store, home) as any;
  assert.match(report.reasoning.id, new RegExp(`work:${work.id}`));
  assert.match(report.reasoning.scopeErrors.personal, /Invalid reasoning report/);
  assert.equal(report.reasoning.summary.askUser, work.summary.askUser);
  store.close();
});
