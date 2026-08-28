import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface KnowledgeReviewHold {
  knowledgeId: string;
  candidateId: string;
  changeTypes: Array<"revise" | "retire">;
  title: string;
  claim: string | null;
  createdAt: string;
}

/**
 * A direct counterexample does not rewrite Knowledge by itself, but the old
 * rule must also not remain silently executable while review is pending.
 * Holds are a derived, fail-closed view over pending Experience candidates.
 */
export function listKnowledgeReviewHolds(home: string): KnowledgeReviewHold[] {
  const directory = join(resolve(home), "experiences", "candidates");
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(`Experience candidate directory must be a real directory: ${directory}`);
  const holds: KnowledgeReviewHold[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Experience candidate must not be a symlink: ${path}`);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!["pending_review", "accepted"].includes(String(value.status)) || typeof value.id !== "string") continue;
    const changeTypes = Array.isArray(value.changeTypes)
      ? value.changeTypes.filter((item): item is "revise" | "retire" => item === "revise" || item === "retire")
      : [];
    const targetKnowledgeIds = Array.isArray(value.targetKnowledgeIds)
      ? value.targetKnowledgeIds.filter((item): item is string => typeof item === "string" && /^kb-/.test(item))
      : [];
    if (changeTypes.length === 0 || targetKnowledgeIds.length === 0) continue;
    const candidateKnowledge = value.candidateKnowledge && typeof value.candidateKnowledge === "object" && !Array.isArray(value.candidateKnowledge)
      ? value.candidateKnowledge as Record<string, unknown>
      : {};
    for (const knowledgeId of targetKnowledgeIds) {
      holds.push({
        knowledgeId,
        candidateId: value.id,
        changeTypes,
        title: typeof value.title === "string" ? value.title : value.id,
        claim: typeof candidateKnowledge.claim === "string" ? candidateKnowledge.claim : null,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
      });
    }
  }
  return holds.sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId) || left.candidateId.localeCompare(right.candidateId));
}

export function heldKnowledgeIds(home: string): Set<string> {
  return new Set(listKnowledgeReviewHolds(home).map((hold) => hold.knowledgeId));
}
