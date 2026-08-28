import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveLedgerPath } from "./layout.ts";

export interface CompactDoctorHealth {
  checkedAt: string;
  ok: boolean;
  events: number | null;
  sources: number | null;
  candidates: number | null;
  experiences: number | null;
  experienceCandidates: number | null;
  brokenChains: number | null;
  sourceIssues: number | null;
  candidateIssues: number | null;
  incrementalIssues: number | null;
  experienceIssues: number | null;
  knowledgeLayoutOk: boolean | null;
  qualityIssues: number | null;
}

export interface CompactLedgerHealth {
  checkedAt: string;
  ok: boolean;
  events: number | null;
  brokenChains: number | null;
}

export interface HealthSnapshot {
  schema: "ikb-health-snapshot.v1";
  updatedAt: string;
  doctor: CompactDoctorHealth | null;
  ledger: CompactLedgerHealth | null;
}

export type HealthState = "ok" | "error" | "stale";

export function healthSnapshotPath(home: string): string {
  return join(resolve(home), "governance", "system", "health.json");
}

export function readHealthSnapshot(home: string): HealthSnapshot {
  const path = healthSnapshotPath(home);
  if (!existsSync(path)) return { schema: "ikb-health-snapshot.v1", updatedAt: "", doctor: null, ledger: null };
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`Health snapshot must be a regular file: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as HealthSnapshot;
  if (value.schema !== "ikb-health-snapshot.v1") throw new Error(`Invalid health snapshot: ${path}`);
  return value;
}

export function buildHealthView(home: string) {
  const snapshot = readHealthSnapshot(home);
  const snapshotPath = healthSnapshotPath(home);
  const ledgerPath = resolveLedgerPath(home);
  const ledgerModifiedAt = existsSync(ledgerPath) ? statSync(ledgerPath).mtime.toISOString() : null;
  const snapshotPersistedAt = existsSync(snapshotPath) ? statSync(snapshotPath).mtime.toISOString() : snapshot.updatedAt;
  const stale = !snapshot.updatedAt || (ledgerModifiedAt !== null && ledgerModifiedAt > snapshotPersistedAt);
  const doctor = snapshot.doctor
    ? { ...snapshot.doctor, stale }
    : { ok: false, unavailable: true, stale: true, error: "尚无 doctor 维护快照" };
  const ledger = snapshot.ledger
    ? { ...snapshot.ledger, stale }
    : { ok: false, unavailable: true, stale: true, error: "尚无 ledger 维护快照" };
  const state: HealthState = stale ? "stale" : doctor.ok && ledger.ok ? "ok" : "error";
  return {
    schema: "ikb-health-view.v1" as const,
    generatedAt: new Date().toISOString(),
    state,
    updatedAt: snapshot.updatedAt,
    ledgerModifiedAt,
    stale,
    doctor,
    ledger,
  };
}

export function writeDoctorHealth(home: string, result: Record<string, unknown>): HealthSnapshot {
  const checkedAt = new Date().toISOString();
  return mergeHealth(home, {
    doctor: {
      checkedAt,
      ok: result.ok === true,
      events: numberValue(result.events),
      sources: numberValue(result.sources),
      candidates: numberValue(result.candidates),
      experiences: numberValue(result.experiences),
      experienceCandidates: numberValue(result.experienceCandidates),
      brokenChains: countValue(result.brokenChains),
      sourceIssues: countValue(result.sourceIssues),
      candidateIssues: countValue(result.candidateIssues),
      incrementalIssues: countValue((result.incrementalState as Record<string, unknown> | undefined)?.issues),
      experienceIssues: countValue(result.experienceIssues),
      knowledgeLayoutOk: booleanValue((result.knowledgeLayout as Record<string, unknown> | undefined)?.ok),
      qualityIssues: countValue((result.knowledgeLayout as Record<string, unknown> | undefined)?.qualityIssues),
    },
  });
}

export function writeLedgerHealth(home: string, result: Record<string, unknown>): HealthSnapshot {
  const replay = (result.replay && typeof result.replay === "object" ? result.replay : result) as Record<string, unknown>;
  const checkedAt = new Date().toISOString();
  return mergeHealth(home, {
    ledger: {
      checkedAt,
      ok: countValue(replay.brokenChains) === 0,
      events: numberValue(replay.events),
      brokenChains: countValue(replay.brokenChains),
    },
  });
}

function mergeHealth(home: string, change: Partial<Pick<HealthSnapshot, "doctor" | "ledger">>): HealthSnapshot {
  const current = readHealthSnapshot(home);
  const snapshot: HealthSnapshot = {
    schema: "ikb-health-snapshot.v1",
    updatedAt: new Date().toISOString(),
    doctor: change.doctor ?? current.doctor,
    ledger: change.ledger ?? current.ledger,
  };
  const path = healthSnapshotPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return snapshot;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countValue(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  return numberValue(value);
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
