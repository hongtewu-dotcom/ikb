---
name: ikb-knowledge-curator
description: Convert evidence-backed findings from chats, Agent sessions, important documents, and review comments into Obsidian-compatible ikb knowledge candidates. Use when an Agent must normalize, deduplicate, link, review, retire, or verify knowledge while preserving sources and ledger traceability.
---

# IKB Knowledge Curator

Use this skill after intake or analysis. Keep the source evidence, create a small candidate, and make the admission decision explicit.

IKB has two different candidate layers: an Input Candidate points to material that still needs to be read (for example a Citadel search hit), while a Knowledge Candidate is a proposed durable claim. Do not treat a discovered external link or search result as a Knowledge Candidate; resolve it to a cited Source first.

## Curation workflow

1. Decide `admit` or `skip` for every analyzed source or source group. Admit when the evidence supports a durable claim that can change a future decision or action, even if it is not yet task-validated: keep it as a clearly marked `draft` and make the validation gap explicit. Skip only when there is no durable/useful claim, the evidence cannot support the claim, or the material is already covered. Source length is not a quality signal, and `candidate_knowledge: []` is valid.
2. For `skip`, require a source reference and a concrete reason, run `knowledge skip`, and create no Knowledge Markdown. A rejected Knowledge Candidate is the audit record.
3. For `admit`, require at least one evidence reference. A path, message ID, document revision, review location, Artifact, Run, commit, or user confirmation can be a reference.
4. Classify `type` as `fact`, `decision`, `preference`, `playbook`, `entity`, or `goal`. Choose `collection` independently as `domains`, `projects`, `people`, `concepts`, `decisions`, `playbooks`, `lessons`, or `syntheses`; choose `scope` and `sensitivity` from the evidence, never from convenience.
5. Reduce the candidate to one durable claim per note. State why it deserves admission, when it applies, and where it stops. Search existing verified and draft notes before creating a new one; detect duplicate, revision, stale, and conflicting claims.
6. Create or update a `draft` Markdown note. Preserve the source reference and the original candidate in the Run or Artifact. Source-derived drafts must provide `admission_reason`, `applicability`, and `boundary`; the deterministic gate rejects missing fields before writing.
7. Add Obsidian relations only when the evidence supports them:
   - `derived_from`: new conclusion points to its evidence or prior conclusion;
   - `related`: same topic or complementary rule;
   - `contradicts`: two claims cannot both be current.
8. Run `knowledge lint` before asking for confirmation. Ask for confirmation before `verified`; a verified entry must retain a source reference. Retire an old claim instead of silently overwriting it.

Before presenting multiple Drafts for review, run `./bin/ikb reasoning run --scope <scope> --json`. The report is a deterministic compression layer, not a lifecycle mutation: it records why low-risk boundaries were auto-resolved, defers current configuration/SOP/validation gaps to a concrete Task, and groups only high-risk person/policy/external-action decisions into `decisionBundles`. Keep the full numbered `待确认` section in each Draft for traceability, but present the user with the report's compressed queue first. Never use the number of Drafts or confirmation items as a quality metric.

Every non-person draft must be a Knowledge Card, not a compressed abstract. Keep the conclusion atomic, then retain the evidence chain, reasoning, applicability/preconditions, execution or decision path, exceptions/failure modes, validation plan, `confidence` (`low|medium|high`) with `confidence_basis`, and `temporal_state`. Every new `quality_version: 3` card must also carry a task-facing use contract: `use_when`, `use_inputs`, `use_outputs`, ordered `use_steps`, `use_checks`, and `use_stop_conditions`. These fields are what an Agent consumes in a Context Pack; without them the note is evidence, not an execution recipe. A short body is acceptable only when the linked Analysis Artifact contains the omitted detail and the note points to it. `confidence` describes evidence strength; `status` describes lifecycle; `verification` describes whether a real Task, drill, or user confirmation has tested the claim. `draft` means “usable as an explicitly marked proposal/checklist”, not “discarded”.

For business-structured sources, curate from the Analyst's `business_package`, not from its headline summary. Keep the package's sections separate and link them: `domain_profile`, `glossary`, `entities`, `flows`, `entry_points`, `service_facts`, `data_access`, `playbooks`, `decisions`, `lessons`, `gaps`, and `eval_cases`. One source may therefore produce a domain fact package plus several atomic Entity/Flow/Playbook/Decision cards. Do not merge an entry index, a business lifecycle, and an architectural decision into one generic synthesis. If a section has no evidence, record the gap or leave it empty; never manufacture a placeholder Knowledge note. A short index card is allowed only when it points to the full fact package and the original Source.

Curator must preserve the Analyst's `extraction_mode` instead of flattening all candidates into `fact`: `entity` keeps relations/lifecycle/invariants, `flow/entry` keeps ordered nodes and anchors, `service/data_fact` keeps reproducible code facts, `decision` keeps alternatives and state, `playbook` keeps branches/rollback, `lesson` keeps incident-to-recheck, `review/writing` keeps comment disposition and revision reason, and `person` keeps the specific observation view. A person card may contain only one or two views; the dossier remains the richer evidence projection and is rebuilt later.

Every draft handed to the user must end with a visible `待确认（请只回复编号）` section. Each numbered item must identify the exact claim or boundary to confirm and the downstream action it unlocks; never hand over a generic “请确认是否正确”。For a person card, the items must separately cover identity, repeated observation, applicable scope, and intended use.

### Person-derived knowledge

Treat a person dossier and a person-analysis Artifact as different objects. The dossier is a rebuildable evidence view; it is not a profile fact. Curate only explicit or repeated, work-relevant observations into a small `entity`, `fact`, `preference`, or `playbook` draft under the `people` collection. A valid person-derived draft must:

- retain exact identity, episode, and source-record refs;
- describe an observable topic, decision criterion, communication shape, ownership, or constraint;
- may describe a repeated writing pattern, reusable work capability, or collaboration contract when the concrete input/output and authored/accepted evidence are retained;
- state the time range and whether the observation is current, historical, or unresolved;
- avoid personality, motive, loyalty, competence, private life, or demographic inference;
- keep one-off remarks and group co-presence as evidence or unknowns, not Knowledge.
- record `identity_confidence`, `pattern_confidence`, and `independent_episode_count`; the deterministic gate requires high identity confidence, at least medium pattern confidence, and two independent episodes before a quality-version-2 person card can proceed.
- for a capability or writing card, also record the concrete input, output, task/result, and `capability_boundary`; never turn a repeated output into a global competence or personality judgment.

When a person analysis has no repeated or actionable claim, `person_profile_candidates: []` is the correct result. Do not manufacture a profile note merely because a key-person dossier exists.

Person curation is a consolidation step, not a per-message update. Compare the current analysis Artifact with the previous one and preserve the transition as `added`, `unchanged`, `superseded`, `conflicted`, or `unknown`. Never rewrite a verified person note in place; create a revision or a new draft with the newer evidence and leave the old claim traceable. A new message can strengthen an existing candidate, but it cannot by itself satisfy the independent-episode gate.

## Current commands

Use the deterministic CLI substrate when direct Core calls are unavailable:

```bash
./bin/ikb capture <file-or-text> --title "..." --scope personal|work --collection <collection> --admission-reason "..." --applicability "..." --boundary "..."
./bin/ikb ingest <markdown-file> --scope personal|work --collection <collection> --admission-reason "..." --applicability "..." --boundary "..."
./bin/ikb knowledge skip --title "..." --reason "..." --source-id <source-id>
./bin/ikb knowledge lint [knowledge-id]
./bin/ikb search "..." --status draft|verified
./bin/ikb knowledge relate <from-id> <to-id> --type related|derived_from|contradicts
./bin/ikb knowledge verify <id>
./bin/ikb knowledge retire <id>
```

Do not expose a long CLI sequence to the user when one Skill invocation can perform the workflow. Use CLI output as an audit trail and fallback, not as a second implementation of curation logic.

## Document and review candidates

Treat important writing and review as first-class evidence. Candidate examples:

- accepted review rule → `playbook` or `fact`;
- rejected review suggestion with reason → `decision` or `pitfall` evidence;
- repeated document structure → `playbook`;
- stable writing preference → `preference`;
- final document conclusion → `decision` with document revision reference;
- recurring reviewer concern → `risk` evidence, not automatically a universal fact.

Keep draft diff, reviewer, location, response, and verification result attached to the candidate. Do not retain only the polished final sentence.

## Obsidian rules

Generated notes use YAML frontmatter with stable `id`, `type`, `collection`, `aliases`, `source_refs`, `tags`, `related`, `derived_from`, and `contradicts`. `type` states what the claim is; `collection` states where a human browses it. For example, a `fact` about a stakeholder belongs in `people`, while a `fact` about a system concept belongs in `concepts`.

Use `[[id|title]]` links. `related` and `contradicts` are reciprocal; `derived_from` points from the new note to the source note. Treat Vault `index.md` files as generated views: never curate them as knowledge or edit them by hand. Rebuild views with `./bin/ikb knowledge rebuild` when needed.

Keep personal and work Vaults isolated. Cross-scope links require explicit confirmation. Do not link every search hit: retrieval is not a semantic relation.

## Output contract

Return:

```yaml
created: knowledge IDs, collections, and paths
updated: knowledge IDs and changed fields
relations: relation type, source ID, target ID, and whether reciprocal
evidence_refs: sources used for the decision
skipped: rejected candidate IDs, evidence refs, and reasons; empty when admitted
blocked: candidates waiting for source, conflict resolution, or human confirmation
next_action: verify, clarify, revise, retire, or leave draft
```

Never create a generic summary merely to make a source produce Knowledge. Never mark a candidate `verified` merely because an Agent generated it. Never overwrite a verified claim without a revision and an event in the ledger.
