import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createDefaultEvalRegistry } from "../src/eval-registry.ts";
import { runEvalSuite } from "../src/eval-runner.ts";
import { sha256Bytes, SPECX_ARTIFACT_PRODUCERS, SPECX_ARTIFACT_REF_SCHEMA, type SpecxArtifactKind, type SpecxArtifactRef } from "../src/specx-artifact-contract.ts";
import { loadSpecxChangeSubject } from "../src/specx-change-subject.ts";
import { SPECX_CHANGE_QUALITY_SUITE_ID } from "../src/specx-change-assessment.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface AssessmentFixture {
  changeDir: string;
  workspace: string;
  head: string;
  options: {
    reviewVerdict: "LGTM" | "BLOCKED";
    checkResult: "pass" | "fail";
    caseStatus: string;
    capabilityStatus: string;
    cleanupStatus: string;
    includeLog: boolean;
    logStatus: string;
    logAssertionStatus: string;
    logEvidenceRefs: string[];
    logVerifiedAt: string;
    caseResultExtraField: boolean;
    logExtraField: boolean;
    cargoCommit: string;
    caseSpecHashOverride: string;
    caseCapabilities: string[];
    useHttpOutcome: boolean;
    omitChainResult: boolean;
    includeRecoveredHistory: boolean;
    legacyResult: string;
  };
  rewrite(): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function artifact(changeDir: string, kind: SpecxArtifactKind, value: unknown): SpecxArtifactRef {
  const raw = Buffer.from(`${JSON.stringify(value)}\n`);
  const hash = sha256Bytes(raw);
  const ref: SpecxArtifactRef = {
    schema: SPECX_ARTIFACT_REF_SCHEMA,
    kind,
    ref: `.specx/artifacts/${hash}.json`,
    sha256: hash,
    producer: SPECX_ARTIFACT_PRODUCERS[kind],
  };
  writeFileSync(join(changeDir, ref.ref), raw);
  return ref;
}

function fileHash(path: string): string {
  return `sha256:${sha256Bytes(readFileSync(path))}`;
}

function fixture(t: TestContext): AssessmentFixture {
  const root = mkdtempSync(join(tmpdir(), "specx-assessment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changeDir = join(root, "flight-change");
  const workspace = join(root, "workspace");
  mkdirSync(join(changeDir, ".specx", "artifacts"), { recursive: true });
  mkdirSync(workspace);
  git(workspace, ["init"]);
  git(workspace, ["checkout", "-b", "main"]);
  writeFileSync(join(workspace, "tracked.txt"), "initial\n");
  git(workspace, ["add", "tracked.txt"]);
  git(workspace, ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "commit", "-m", "initial"]);
  const head = git(workspace, ["rev-parse", "HEAD"]);

  writeFileSync(join(changeDir, "analyze.md"), "# Analyze\n");
  writeFileSync(join(changeDir, "clarify.md"), "# Clarify\n");
  writeFileSync(join(changeDir, "design.md"), "# Design\n");
  writeFileSync(join(changeDir, "change-manifest.yaml"), stringifyYaml({
    version: 2,
    change: { name: "flight-change" },
    source: { prd_url: "https://km.sankuai.com/collabpage/test", retrieval: "direct" },
    entry_inventory: [{ id: "E-1", service: "flight-order-ticketing", kind: "thrift", symbol: "TicketService.create", disposition: "change" }],
    acceptance_criteria: [{ id: "AC-1", description: "出票成功", prd_refs: ["3.2"], entries: ["E-1"] }],
    tasks: [{ id: "T-1", service: "flight-order-ticketing", entries: ["E-1"], description: "实现" }],
  }));
  const at = "2026-08-04T00:00:00.000Z";
  writeFileSync(join(changeDir, "approvals.yaml"), stringifyYaml({
    version: 1,
    records: [
      {
        kind: "stage",
        stage: "clarify",
        approved_by: "tester",
        approved_at: at,
        artifact_hashes: {
          "analyze.md": fileHash(join(changeDir, "analyze.md")),
          "clarify.md": fileHash(join(changeDir, "clarify.md")),
        },
      },
      {
        kind: "stage",
        stage: "design",
        approved_by: "tester",
        approved_at: at,
        artifact_hashes: {
          "analyze.md": fileHash(join(changeDir, "analyze.md")),
          "clarify.md": fileHash(join(changeDir, "clarify.md")),
          "design.md": fileHash(join(changeDir, "design.md")),
          "change-manifest.yaml": fileHash(join(changeDir, "change-manifest.yaml")),
        },
      },
    ],
  }));

  const options: AssessmentFixture["options"] = {
    reviewVerdict: "LGTM",
    checkResult: "pass",
    caseStatus: "passed",
    capabilityStatus: "passed",
    cleanupStatus: "passed",
    includeLog: true,
    logStatus: "pass",
    logAssertionStatus: "pass",
    logEvidenceRefs: ["logcenter:test:plog-created"],
    logVerifiedAt: at,
    caseResultExtraField: false,
    logExtraField: false,
    cargoCommit: head,
    caseSpecHashOverride: "",
    caseCapabilities: ["flight.chain.execute", "cleanup.order"],
    useHttpOutcome: false,
    omitChainResult: false,
    includeRecoveredHistory: false,
    legacyResult: "PASS",
  };

  const value: AssessmentFixture = {
    changeDir,
    workspace,
    head,
    options,
    rewrite() {
      const cargo = artifact(changeDir, "cargo-manifest", {
        env: "test",
        readyForAgent: true,
        stackUuid: "stack-1",
        taskUuid: "task-1",
        swimlane: "lane-1",
        preflight: { commit: head },
        waitResult: {
          status: "ready",
          selectedBuild: { taskUuid: "task-1" },
          stack: { stackUUID: "stack-1", swimlane: "lane-1" },
          checks: {
            deploymentStateSeen: true,
            totalCountPositive: true,
            allReplicasRunning: true,
            noErrors: true,
            allRunnersRunning: true,
            domainsPresent: true,
          },
        },
      });
      const caseSpec = artifact(changeDir, "flight-case-spec", {
        schemaVersion: 1,
        caseId: "flight-case-1",
        environment: "test",
        capabilities: options.useHttpOutcome ? ["http.case.execute"] : options.caseCapabilities,
      });
      const results: Array<Record<string, unknown>> = [];
      if (options.useHttpOutcome) {
        results.push({ capability: "http.case.execute", status: options.capabilityStatus, evidence: {} });
      } else {
        if (options.includeRecoveredHistory) {
          results.push({ capability: "flight.chain.execute", status: "required", evidence: {} });
        }
        if (!options.omitChainResult) {
          results.push({ capability: "flight.chain.execute", status: options.capabilityStatus, evidence: {} });
        }
        results.push({ capability: "cleanup.order", status: options.cleanupStatus, evidence: {} });
      }
      const caseResult = artifact(changeDir, "flight-case-result", {
        schema: "flight-case-result-v2",
        caseId: "flight-case-1",
        caseSpecHash: options.caseSpecHashOverride || caseSpec.sha256,
        runnerVersion: "v2",
        runnerHash: "a".repeat(64),
        startedAt: at,
        finishedAt: at,
        environment: "test",
        cargoManifest: { ref: "/tmp/cargo.json", sha256: cargo.sha256, commit: options.cargoCommit },
        status: options.caseStatus,
        results,
        budget: { requests: 2 },
        ...(options.caseResultExtraField ? { forged: true } : {}),
      });
      const artifacts: SpecxArtifactRef[] = [caseSpec, caseResult];
      if (options.includeLog) {
        artifacts.push(artifact(changeDir, "flight-log-verification", {
          schema: "flight-log-verification-v1",
          caseId: "flight-case-1",
          caseResultHash: caseResult.sha256,
          environment: "test",
          status: options.logStatus,
          assertions: [{
            id: "plog-created",
            status: options.logAssertionStatus,
            evidenceRefs: options.logEvidenceRefs,
            ...(options.logAssertionStatus === "pass" ? {} : { reasonCode: "assertion_not_passed" }),
          }],
          verifiedAt: options.logVerifiedAt,
          ...(options.logExtraField ? { forged: true } : {}),
        }));
      }
      writeFileSync(join(changeDir, "execution-evidence.yaml"), stringifyYaml({
        version: 1,
        workspaces: [{ service: "flight-order-ticketing", repo: workspace, path: workspace, branch: "main", base_commit: head, head_commit: head }],
        implementations: [{ entry: "E-1", service: "flight-order-ticketing", commit: head, checks: [{ name: "test", result: options.checkResult }] }],
        reviews: [{ service: "flight-order-ticketing", base_commit: head, head_commit: head, verdict: options.reviewVerdict, findings: [] }],
        deployments: [{ service: "flight-order-ticketing", lane: "lane-1", build_id: "build-1", commit: head, manifest: cargo }],
        verification: [{
          ac: "AC-1",
          result: options.legacyResult,
          evidence: ["legacy-pass"],
          human_confirmed: { by: "tester", at, reason: "legacy waiver" },
          waiver: { approved: true },
          artifacts,
        }],
      }));
    },
  };
  value.rewrite();
  return value;
}

function evaluate(value: AssessmentFixture) {
  const subject = loadSpecxChangeSubject(value.changeDir);
  return runEvalSuite(createDefaultEvalRegistry(), SPECX_CHANGE_QUALITY_SUITE_ID, { projectRoot, subject });
}

function status(output: ReturnType<typeof evaluate>, caseId: string): string {
  return output.results.find((result) => result.caseId === caseId)?.status ?? "missing";
}

test("a complete real Git Change passes all three required SpecX cases", (t) => {
  const value = fixture(t);
  const output = evaluate(value);
  assert.deepEqual(output.results.map((result) => [result.caseId, result.status]), [
    ["specx-source-integrity", "pass"],
    ["specx-evidence-provenance", "pass"],
    ["specx-flight-outcome", "pass"],
  ]);
  assert.equal(output.report.hardGatePassed, true);
});

test("declared capability coverage is required while bounded recovery uses the latest result", (t) => {
  const missingCapability = fixture(t);
  missingCapability.options.omitChainResult = true;
  missingCapability.rewrite();
  assert.equal(status(evaluate(missingCapability), "specx-flight-outcome"), "inconclusive");

  const recovered = fixture(t);
  recovered.options.includeRecoveredHistory = true;
  recovered.rewrite();
  const recoveredOutput = evaluate(recovered);
  assert.equal(status(recoveredOutput, "specx-flight-outcome"), "pass");
  assert.equal(recoveredOutput.report.hardGatePassed, true);
});

test("setup-only CaseSpec cannot satisfy the real flight outcome gate", (t) => {
  const value = fixture(t);
  value.options.caseCapabilities = ["cargo.ready"];
  value.rewrite();
  const output = evaluate(value);
  assert.equal(status(output, "specx-flight-outcome"), "inconclusive");
  assert.equal(output.report.hardGatePassed, false);
  assert.ok(output.results.find((result) => result.caseId === "specx-flight-outcome")?.reasonCodes.includes("flight_outcome_capability_missing"));
});

test("bounded HTTP execution is also a valid real outcome capability", (t) => {
  const value = fixture(t);
  value.options.useHttpOutcome = true;
  value.rewrite();
  const output = evaluate(value);
  assert.equal(status(output, "specx-flight-outcome"), "pass");
  assert.equal(output.report.hardGatePassed, true);
});

test("dirty Git state, Cargo mismatch and CaseSpec mismatch are inconclusive", (t) => {
  const dirty = fixture(t);
  writeFileSync(join(dirty.workspace, "tracked.txt"), "dirty\n");
  assert.equal(status(evaluate(dirty), "specx-source-integrity"), "inconclusive");

  const cargoMismatch = fixture(t);
  cargoMismatch.options.cargoCommit = "b".repeat(40);
  cargoMismatch.rewrite();
  const output = evaluate(cargoMismatch);
  assert.equal(status(output, "specx-evidence-provenance"), "inconclusive");
  assert.equal(output.report.hardGatePassed, false);

  const caseSpecMismatch = fixture(t);
  caseSpecMismatch.options.caseSpecHashOverride = "c".repeat(64);
  caseSpecMismatch.rewrite();
  const mismatchedOutput = evaluate(caseSpecMismatch);
  assert.equal(status(mismatchedOutput, "specx-evidence-provenance"), "inconclusive");
  assert.equal(status(mismatchedOutput, "specx-flight-outcome"), "inconclusive");
});

test("unexpected workspace, implementation, deployment or AC evidence is not silently ignored", (t) => {
  const value = fixture(t);
  const evidencePath = join(value.changeDir, "execution-evidence.yaml");
  const evidence = parseYaml(readFileSync(evidencePath, "utf8")) as Record<string, Array<Record<string, unknown>>>;
  evidence.workspaces.push({ service: "unexpected", repo: value.workspace, path: value.workspace, branch: "main", base_commit: value.head, head_commit: value.head });
  evidence.implementations.push({ entry: "E-X", service: "unexpected", commit: value.head, checks: [{ name: "test", result: "pass" }] });
  evidence.deployments.push({ service: "unexpected", lane: "lane-x", build_id: "build-x", commit: value.head, manifest: evidence.deployments[0].manifest });
  evidence.verification.push({ ac: "AC-X", artifacts: evidence.verification[0].artifacts });
  writeFileSync(evidencePath, stringifyYaml(evidence));
  const output = evaluate(value);
  assert.equal(status(output, "specx-source-integrity"), "inconclusive");
  assert.equal(status(output, "specx-evidence-provenance"), "inconclusive");
  assert.equal(output.report.hardGatePassed, false);
});

test("producer payloads with unsupported fields are not accepted as valid contracts", (t) => {
  const caseResult = fixture(t);
  caseResult.options.caseResultExtraField = true;
  caseResult.options.caseStatus = "failed";
  caseResult.options.capabilityStatus = "failed";
  caseResult.rewrite();
  assert.equal(status(evaluate(caseResult), "specx-evidence-provenance"), "inconclusive");
  assert.equal(status(evaluate(caseResult), "specx-flight-outcome"), "inconclusive");

  const log = fixture(t);
  log.options.logExtraField = true;
  log.options.logStatus = "fail";
  log.options.logAssertionStatus = "fail";
  log.rewrite();
  assert.equal(status(evaluate(log), "specx-evidence-provenance"), "inconclusive");
  assert.equal(status(evaluate(log), "specx-flight-outcome"), "inconclusive");
});

test("explicit implementation, review, business, log and cleanup failures remain FAIL", (t) => {
  const implementation = fixture(t);
  implementation.options.checkResult = "fail";
  implementation.rewrite();
  assert.equal(status(evaluate(implementation), "specx-source-integrity"), "fail");

  const review = fixture(t);
  review.options.reviewVerdict = "BLOCKED";
  review.rewrite();
  assert.equal(status(evaluate(review), "specx-source-integrity"), "fail");

  const business = fixture(t);
  business.options.caseStatus = "failed";
  business.options.capabilityStatus = "failed";
  business.options.includeLog = false;
  business.rewrite();
  assert.equal(status(evaluate(business), "specx-flight-outcome"), "fail");

  const log = fixture(t);
  log.options.logStatus = "fail";
  log.options.logAssertionStatus = "fail";
  log.rewrite();
  assert.equal(status(evaluate(log), "specx-flight-outcome"), "fail");

  const cleanup = fixture(t);
  cleanup.options.cleanupStatus = "cleanup_failed";
  cleanup.rewrite();
  assert.equal(status(evaluate(cleanup), "specx-flight-outcome"), "fail");
});

test("missing or unavailable logs are inconclusive and legacy PASS or waiver cannot override", (t) => {
  const missing = fixture(t);
  missing.options.includeLog = false;
  missing.rewrite();
  const missingOutput = evaluate(missing);
  assert.equal(status(missingOutput, "specx-source-integrity"), "pass");
  assert.equal(status(missingOutput, "specx-evidence-provenance"), "inconclusive");
  assert.equal(status(missingOutput, "specx-flight-outcome"), "inconclusive");
  assert.equal(missingOutput.report.hardGatePassed, false);

  const unavailable = fixture(t);
  unavailable.options.logStatus = "inconclusive";
  unavailable.options.logAssertionStatus = "inconclusive";
  unavailable.options.legacyResult = "PASS";
  unavailable.rewrite();
  assert.equal(status(evaluate(unavailable), "specx-flight-outcome"), "inconclusive");

  const unproven = fixture(t);
  unproven.options.logEvidenceRefs = [];
  unproven.rewrite();
  assert.equal(status(evaluate(unproven), "specx-flight-outcome"), "inconclusive");

  const premature = fixture(t);
  premature.options.logVerifiedAt = "2026-08-03T23:59:59.999Z";
  premature.rewrite();
  const prematureOutput = evaluate(premature);
  assert.equal(status(prematureOutput, "specx-evidence-provenance"), "inconclusive");
  assert.equal(status(prematureOutput, "specx-flight-outcome"), "inconclusive");
});
