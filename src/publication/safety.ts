import type { KnowledgeRecord } from "../types.ts";
import { inspectPersonalAdmission } from "../knowledge/personal-admission.ts";

export interface PublicationGateIssue {
  code: string;
  detail: string;
}

const SENSITIVE_PATTERNS: Array<{ code: string; pattern: RegExp; detail: string }> = [
  { code: "private_lineage_id", pattern: /\b(?:kb|src|run|artifact)-[a-z0-9-]{6,}\b/i, detail: "contains a private IKB lineage identifier" },
  { code: "private_lineage_ref", pattern: /\b(?:artifact|fact|user-confirmation):[^\s)\]}>]+/i, detail: "contains a private evidence reference" },
  { code: "internal_domain", pattern: /\b[\w.-]+\.(?:sankuai|meituan)\.com\b/i, detail: "contains an internal domain" },
  {
    code: "internal_product",
    pattern: /\b(?:CatDesk|CatPaw|Multica|SpecX|Lion|DMS|Raptor|LogCenter|Mafka|Cockpit Tools|Friday|MIS|SSO|api_booking)\b|(?:美团|大象|学城|魔数|内网)/i,
    detail: "contains an internal product or workspace name",
  },
  { code: "local_path", pattern: /(?:^|[\s("'`])\/Users\/[^/\s]+\/|(?:^|[\s("'`])~\/(?:\.|projects\/)/m, detail: "contains a local filesystem path" },
  { code: "credential", pattern: /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)\b\s*[:=]\s*\S+/i, detail: "contains a credential-like assignment" },
  { code: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, detail: "contains a private key" },
  { code: "internal_identifier", pattern: /\b(?:com\.(?:sankuai|meituan)\.[\w.-]+|appkey)\b/i, detail: "contains an internal service or AppKey identifier" },
  { code: "long_numeric_identifier", pattern: /(?:^|[^A-Za-z0-9])\d{11,24}(?![A-Za-z0-9])/, detail: "contains an order, group, phone or other long numeric identifier" },
  { code: "file_uri", pattern: /\bfile:\/\/\S+/i, detail: "contains a local file URI" },
  { code: "raw_html", pattern: /<\/?[a-z][^>]*>/i, detail: "contains raw HTML; public Markdown must use the safe projection format" },
];

export function inspectPublicationEligibility(record: KnowledgeRecord): PublicationGateIssue[] {
  const issues: PublicationGateIssue[] = [];
  if (record.scope !== "personal") issues.push({ code: "scope_not_personal", detail: `scope must be personal, got ${record.scope}` });
  if (record.status !== "verified") issues.push({ code: "status_not_verified", detail: `status must be verified, got ${record.status}` });
  if (record.sensitivity !== "public") issues.push({ code: "sensitivity_not_public", detail: `sensitivity must be public, got ${record.sensitivity}` });
  if (!["task_validated", "user_confirmed"].includes(record.verification ?? "")) {
    issues.push({
      code: "publication_verification_insufficient",
      detail: `publication requires task_validated or user_confirmed verification, got ${record.verification ?? "missing"}`,
    });
  }
  if (record.temporalState === "superseded") {
    issues.push({ code: "temporal_state_superseded", detail: "superseded Knowledge cannot enter a current public projection" });
  }
  if (record.reviewAfter < new Date().toISOString().slice(0, 10)) {
    issues.push({ code: "review_overdue", detail: `Knowledge review was due on ${record.reviewAfter}` });
  }
  if (record.collection === "people") issues.push({ code: "person_publication_blocked", detail: "person observations and dossiers cannot enter the public projection" });
  for (const issue of inspectPersonalAdmission(record)) issues.push({ code: issue.code, detail: issue.detail });
  return issues;
}

export function inspectPublicText(text: string, generatedPublicIds: string[] = []): PublicationGateIssue[] {
  const inspectable = [...new Set(generatedPublicIds)]
    .filter((id) => /^pub-[a-f0-9]{16}$/.test(id))
    .reduce((current, id) => current.replaceAll(id, "pub-generated-id"), text);
  return SENSITIVE_PATTERNS.flatMap(({ code, pattern, detail }) => pattern.test(inspectable) ? [{ code, detail }] : []);
}
