---
name: ikb-conversation-analysis
description: Analyze selected Elephant chats, Claude Code/Desk/Codex sessions, important documents, drafts, and review comments. Use when an Agent must explain a person's concerns, a decision history, a communication pattern, a document's reasoning, or the lessons behind accepted and rejected feedback with evidence references.
---

# IKB Conversation Analysis

Use this skill to produce an evidence-backed analysis from a bounded set of conversations, documents, comments, or Agent runs. Treat analysis as a report and candidate knowledge, not as an invisible mutation of the Vault.

## Input contract

Require or infer explicitly:

- source kind and permitted scope;
- person, group, project, repository, document, or Task;
- time range or revision range;
- question and intended use;
- output sensitivity and whether a draft may be written.

If the source is not available, state the missing adapter or export. Do not replace missing evidence with general assumptions.

## Evidence workflow

1. Retrieve the smallest relevant set of messages, document versions, comments, and Run artifacts.
2. Preserve `source_id`, `conversation_id`, `message_id`, `document_id`, `revision_id`, URL/path, author, timestamp, and line/location references.
3. Group related items into Episodes. Keep separate conversations separate unless a shared identifier or explicit evidence joins them.
4. Label each statement as `fact`, `inference`, `hypothesis`, or `unknown`.
5. Extract decisions, goals, constraints, commitments, objections, risks, corrections, and unresolved questions.
6. Compare draft/final text and accepted/rejected comments. Record why a change was made when the evidence contains that reason.
7. Return the report with citations before proposing any knowledge candidate.

## Person mode

When the request names a person, describe observable work patterns only:

- recurring goals and concerns;
- decision criteria and risk sensitivity;
- preferred communication shape and level of detail;
- commitments, dependencies, and repeated objections;
- changes over time.

Attach every conclusion to message or document evidence and a time range. Distinguish what the person said from what the Agent infers. Do not infer personality, motive, loyalty, competence, or private life from a small sample.

## Document and review mode

For important writing, analyze the full change path:

```text
source material → outline/draft → review comments → accepted/rejected decisions → final document
```

Extract factual constraints, argument structure, missing evidence, recurring reviewer standards, useful wording patterns, and reasons for changes. An accepted comment may become a `decision`, `pitfall`, or `playbook` candidate; a rejected comment remains evidence with its rejection reason.

For code review or CR, preserve file, line, priority, reviewer, response, and verification result. Do not turn an unverified review opinion into a fact.

## Agent conversation mode

For Claude Code, Desk, or Codex sessions, separate:

- user goal and acceptance;
- assistant reasoning or proposed plan;
- tool calls and file changes;
- tests and verification;
- failure, correction, and final outcome.

Prefer decisions, failures, corrections, and verified outcomes over repeated raw model prose. Link extracted knowledge to the Run, artifact, commit, or test that supports it.

## Output contract

Return:

```yaml
question: original analysis question
scope: personal|work
evidence_refs: source and location references
episodes: grouped evidence with time bounds
findings:
  - statement
    kind: fact|inference|hypothesis|unknown
    evidence_refs: []
decisions: []
risks: []
open_questions: []
candidate_knowledge: []
person_profile_candidates: []
```

Do not mark candidates `verified` and do not send external communication. If the user asks for a document, communication draft, or review response, save it as an Artifact and keep the evidence refs alongside it.
