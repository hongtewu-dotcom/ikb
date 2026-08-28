import { KNOWLEDGE_DIRECTORIES, type KnowledgeDirectory } from "./contracts.ts";

export function knowledgeDirectoryForType(type: string): KnowledgeDirectory {
  const normalized = type.trim().toLowerCase().replaceAll("-", "_");
  if ((KNOWLEDGE_DIRECTORIES as readonly string[]).includes(normalized)) return normalized as KnowledgeDirectory;
  if (["domain", "area", "responsibility"].includes(normalized)) return "domains";
  if (["project", "goal", "initiative"].includes(normalized)) return "projects";
  if (["person", "stakeholder", "contact"].includes(normalized)) return "people";
  if (normalized === "decision") return "decisions";
  if (normalized === "principle") return "principles";
  if (["playbook", "procedure", "workflow", "checklist"].includes(normalized)) return "playbooks";
  if (["lesson", "pitfall", "risk", "experience", "learning"].includes(normalized)) return "lessons";
  if (["synthesis", "analysis", "comparison", "summary", "insight"].includes(normalized)) return "syntheses";
  return "concepts";
}

export function resolveKnowledgeDirectory(type: string, collection?: string): KnowledgeDirectory {
  if (!collection) return knowledgeDirectoryForType(type);
  const normalized = collection.trim().toLowerCase();
  if (!(KNOWLEDGE_DIRECTORIES as readonly string[]).includes(normalized)) {
    throw new Error(`Knowledge collection must be one of: ${KNOWLEDGE_DIRECTORIES.join(", ")}`);
  }
  return normalized as KnowledgeDirectory;
}

export function knowledgeScopes(scope?: string): string[] {
  if (scope && scope !== "personal" && scope !== "work") throw new Error(`Knowledge scope must be personal or work: ${scope}`);
  return scope ? [scope] : ["personal", "work"];
}
