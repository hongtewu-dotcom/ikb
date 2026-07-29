import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishRunAndAssess } from "../run-completion.ts";
import type { LedgerStore } from "../store.ts";
import { buildPublication } from "./build.ts";
import type { PublicationBuildOptions, PublicationBuildResult } from "./contracts.ts";

export interface PublicationBuildRunResult extends PublicationBuildResult {
  taskId: string;
  runId: string;
  artifactIds: string[];
  verificationArtifactId: string;
}

export function buildPublicationRun(
  store: LedgerStore,
  home: string,
  options: PublicationBuildOptions,
): PublicationBuildRunResult {
  const task = store.createTask({
    title: `构建个人知识发布包：${options.channel}`,
    goal: "从已验证的个人公开 Knowledge 构建确定性、安全的本地发布投影。",
    acceptance: "Bundle、输出 Manifest、构建记录和验证报告均已登记，公开产物通过范围、敏感信息与哈希门禁。",
    type: "publication",
    priority: "normal",
    risk: "low",
    scope: "personal",
  });
  const run = store.createRun(task.id, "ikb-harness", ["publication-build"]);
  writePlan(run.runDir);
  const inputRefs = (options.knowledgeIds ?? []).map((id) => `knowledge://${id}`);
  store.recordHarnessEvent(run.id, "run.step_started", {
    stepId: "publication-build",
    stepName: "构建个人知识发布投影",
    loopId: "mid",
    iteration: 0,
    roleId: "任务总管",
    skillId: "publication-build",
    inputRefs,
    outputRefs: [],
  });

  try {
    const result = buildPublication(home, options);
    const verificationPath = join(result.releaseDir, "verification-report.json");
    writeVerificationReport(verificationPath, result);
    const artifactInputs = [
      { kind: "publication_bundle", label: "个人知识发布 Bundle", path: result.bundlePath },
      { kind: "publication_build_record", label: "个人知识发布构建记录", path: result.buildRecordPath },
      { kind: "publication_output_manifest", label: "个人知识发布输出 Manifest", path: join(result.outputDir, "manifest.json") },
      { kind: "publication_verification", label: "个人知识发布验证报告", path: verificationPath },
    ];
    const artifacts = artifactInputs.map((input) => store.createArtifact({ runId: run.id, ...input }));
    const artifactRefs = artifacts.map((artifact) => `artifact://${artifact.id}`);
    for (const artifact of artifacts) {
      store.recordHarnessEvent(run.id, "run.artifact_linked", {
        artifactId: artifact.id,
        relation: "produced",
        lineageRefs: inputRefs,
      });
    }
    store.recordHarnessEvent(run.id, "run.gate_evaluated", {
      gateId: "G0",
      decision: "pass",
      reasonCode: "publication_scope_safe",
      evidenceRefs: artifactRefs,
      gateVersion: "publication-gates.v1",
    });
    store.recordHarnessEvent(run.id, "run.gate_evaluated", {
      gateId: "G6",
      decision: "pass",
      reasonCode: "publication_build_verified",
      evidenceRefs: artifactRefs,
      gateVersion: "publication-gates.v1",
    });
    const verificationEvent = store.recordHarnessEvent(run.id, "run.verification_completed", {
      result: "pass",
      checks: [
        { id: "personal-admission", decision: "pass", evidenceRefs: artifactRefs },
        { id: "sensitive-scan", decision: "pass", evidenceRefs: artifactRefs },
        { id: "output-hash", decision: "pass", evidenceRefs: artifactRefs },
      ],
      artifactRefs,
    });
    const action = buildActionIdentity(result);
    store.recordHarnessEvent(run.id, "run.approval_checked", {
      approvalId: "not-required",
      approvalDecision: "not_required",
      action: "publication.build",
      targetHash: action.targetHash,
      payloadHash: action.payloadHash,
    });
    store.recordHarnessEvent(run.id, "run.action_executed", {
      actionId: `build-${result.releaseId}`,
      action: "publication.build",
      sideEffectLevel: "L1",
      targetHash: action.targetHash,
      payloadHash: action.payloadHash,
      status: "succeeded",
    });
    store.recordHarnessEvent(run.id, "run.step_finished", {
      stepId: "publication-build",
      stepName: "构建个人知识发布投影",
      loopId: "mid",
      iteration: 0,
      inputRefs,
      outputRefs: artifactRefs,
      outputHash: result.outputHash,
      status: "succeeded",
    });
    store.recordPublicationEvent(result.releaseId, "publication.built", {
      channel: result.channel,
      schemaVersion: "ikb-personal-publication.v1",
      bundleHash: result.bundleHash,
      outputHash: result.outputHash,
      entryCount: result.entryCount,
    });
    store.recordPublicationEvent(result.releaseId, "publication.verified", {
      channel: result.channel,
      bundleHash: result.bundleHash,
      outputHash: result.outputHash,
      verifierEventId: verificationEvent.eventId,
      verifierArtifactId: artifacts.at(-1)!.id,
      verifierArtifactHash: artifacts.at(-1)!.contentHash,
    });
    finishRunAndAssess(store, run.id, "succeeded", `publication build ${result.releaseId}`);
    store.transitionTask(task.id, "done", undefined, artifacts[0].id);
    return {
      ...result,
      taskId: task.id,
      runId: run.id,
      artifactIds: artifacts.map((artifact) => artifact.id),
      verificationArtifactId: artifacts.at(-1)!.id,
    };
  } catch (error) {
    store.recordHarnessEvent(run.id, "run.step_finished", {
      stepId: "publication-build",
      stepName: "构建个人知识发布投影",
      loopId: "mid",
      iteration: 0,
      inputRefs,
      outputRefs: [],
      status: "failed",
      errorCode: "publication_build_failed",
      nextAction: "fix_publication_gate",
    });
    finishRunAndAssess(store, run.id, "failed", (error as Error).message);
    store.transitionTask(task.id, "waiting", "publication build failed");
    throw error;
  }
}

function writePlan(runDir: string): void {
  const path = join(runDir, "plan.json");
  writeFileSync(path, `${JSON.stringify({
    status: "planned",
    steps: [{ id: "publication-build", depends_on: [] }],
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeVerificationReport(path: string, result: PublicationBuildResult): void {
  const content = `${JSON.stringify({
    schemaVersion: "ikb-publication-verification.v1",
    releaseId: result.releaseId,
    channel: result.channel,
    result: "pass",
    checks: [
      { id: "personal-admission", result: "pass" },
      { id: "sensitive-scan", result: "pass" },
      { id: "output-hash", result: "pass", hash: result.outputHash },
    ],
    bundleHash: result.bundleHash,
    outputHash: result.outputHash,
  }, null, 2)}\n`;
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Publication verification path is not a regular file: ${path}`);
    if (readFileSync(path, "utf8") !== content) throw new Error(`Publication verification report was modified: ${path}`);
    return;
  }
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function buildActionIdentity(result: PublicationBuildResult): { targetHash: string; payloadHash: string } {
  return {
    targetHash: sha256(`publication://${result.channel}/${result.releaseId}`),
    payloadHash: sha256(stableStringify({ bundleHash: result.bundleHash, outputHash: result.outputHash })),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
