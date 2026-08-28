import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildHealthView, readHealthSnapshot, writeDoctorHealth, writeLedgerHealth } from "../src/health.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "src", "cli.ts");

test("health snapshot merges compact doctor and ledger results without retaining issue bodies", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-health-"));
  writeDoctorHealth(home, {
    ok: false,
    events: 10,
    sources: 2,
    candidates: 3,
    brokenChains: ["event-1"],
    sourceIssues: [{ code: "raw_hash_mismatch", detail: "large detail must not be retained" }],
    candidateIssues: [],
    incrementalState: { issues: [] },
    experienceIssues: [],
    knowledgeLayout: { ok: true, qualityIssues: [] },
  });
  writeLedgerHealth(home, { mode: "verify", replay: { events: 10, brokenChains: [] } });
  const snapshot = readHealthSnapshot(home);
  assert.equal(snapshot.doctor?.ok, false);
  assert.equal(snapshot.doctor?.sourceIssues, 1);
  assert.equal(snapshot.doctor?.knowledgeLayoutOk, true);
  assert.equal(snapshot.ledger?.ok, true);
  assert.equal(snapshot.ledger?.events, 10);
  assert.equal(JSON.stringify(snapshot).includes("large detail"), false);
});

test("compact health reports current validation separately from a stale ledger", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-health-view-"));
  const ledgerDirectory = join(home, "ledger");
  const ledgerPath = join(ledgerDirectory, "events.jsonl");
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(ledgerPath, "");
  writeDoctorHealth(home, { ok: true, events: 12, sources: 4, candidates: 5, brokenChains: [], sourceIssues: [], candidateIssues: [], incrementalState: { issues: [] }, experienceIssues: [], knowledgeLayout: { ok: true, qualityIssues: [] } });
  writeLedgerHealth(home, { replay: { events: 12, brokenChains: [] } });

  const fresh = buildHealthView(home);
  assert.equal(fresh.state, "ok");
  assert.equal(fresh.stale, false);
  const healthyCli = invokeHealth(home);
  assert.equal(healthyCli.status, 0, healthyCli.stderr);
  assert.equal(JSON.parse(healthyCli.stdout).state, "ok");

  const future = new Date(Date.now() + 60_000);
  utimesSync(ledgerPath, future, future);
  const stale = buildHealthView(home);
  assert.equal(stale.state, "stale");
  assert.equal(stale.stale, true);
  const staleCli = invokeHealth(home);
  assert.equal(staleCli.status, 2);
  assert.equal(JSON.parse(staleCli.stdout).state, "stale");
});

function invokeHealth(home: string) {
  return spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", cliPath, "health", "--home", home, "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}
