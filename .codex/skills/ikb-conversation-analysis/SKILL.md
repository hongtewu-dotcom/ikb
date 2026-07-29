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

1. Retrieve the smallest relevant set of messages, document versions, comments, and Run artifacts. For an imported Source, call `./bin/ikb source context <source-id> --limit <n>` and use the returned record IDs as citations.
   If a selected record contains an explicit `km.sankuai.com` URL or `contentId`, run `./bin/ikb candidate discover <source-id>` (or use the automatic discovery result from Source intake). Treat the result as an Input Candidate; do not read the linked document until it is explicitly `queued` and resolved.
2. Preserve `source_id`, `conversation_id`, `message_id`, `document_id`, `revision_id`, URL/path, author, timestamp, and line/location references.
3. Group related items into Episodes. Keep separate conversations separate unless a shared identifier or explicit evidence joins them.
4. Label each statement as `fact`, `inference`, `hypothesis`, or `unknown`.
5. Extract decisions, goals, constraints, commitments, objections, risks, corrections, and unresolved questions.
6. Compare draft/final text and accepted/rejected comments. Record why a change was made when the evidence contains that reason.
7. Give every analyzed source or source group an explicit knowledge disposition: `admit` when it supports at least one durable claim, otherwise `skip` with a reason. Do not use source length or a one-candidate-per-document quota as a proxy for value.
8. Return the report with citations before proposing any knowledge candidate. `candidate_knowledge: []` is a valid successful result.

For a frozen or batch extraction, write one `ikb-knowledge-compilation-result.v2` object per case. Do not start from a candidate card. Start with hashed evidence excerpts, then facts, coverage obligations, claims, and typed consumer products:

```bash
./bin/ikb extraction validate <results.json> --manifest <benchmark-manifest.json> --json
./bin/ikb extraction verify <results.json> --manifest <benchmark-manifest.json> --json
```

The v2 manifest must freeze independent coverage obligations before extraction. `validate` checks the producer contract; `verify` checks evidence integrity, core coverage, fact-backed claims, type shape, and person selectivity. A core obligation marked `omitted` or `unknown` blocks `admit`; retain the available facts and a Gap instead. If either command fails, fix the compilation; do not create or update Knowledge.

Before handing a batch of drafts to a human, run the global reasoning compression layer:

```bash
./bin/ikb reasoning run --scope <scope> --json
```

Keep every original confirmation item in the Draft/Artifact for replay, but classify it as `auto_resolved`, `defer_until_task`, or `ask_user`. Do not ask the user about an existing boundary (for example, example numbers are not production thresholds, local drafts do not write external systems) or a current-evidence gap that belongs to a future Task. Only person identity/recurrence/use, high-risk Approval or blocking rules, external side effects, and choices that evidence cannot determine enter the compressed user decision queue.

For non-person knowledge, preserve a complete fact inventory before producing a consumer view. A consumer view may be atomic, but it must cite `fact_refs` in the compilation and must not replace source objects, relations, states, numbers, or boundaries with a generic method. Use `quality_version: 4` for new Knowledge. Set `product_type`, `compilation_ref`, `fact_refs`, and `questions_answered`. Only `playbook` requires ordered `use_steps`, checks, rollback, and stop conditions. `architecture_map` requires explicit nodes/edges/version/state; `domain_pack` requires entities/relations/rules/states; `entity_card` requires fields/relations/lifecycle/invariants; `flow_card` requires trigger/nodes/edges/exceptions/recovery; `decision_card` requires context/options/choice/state/rationale/rejected/impact. Confidence is evidence strength, not probability; `verified` still requires the configured verification path.

When a source has real business structure (business model, protocol, architecture, flow, SOP, review, or roadmap), produce a **business extraction package** before proposing Knowledge. The package is an indexed evidence artifact, not a long abstract, and may contain empty sections when the source does not support them:

```yaml
business_package:
  domain_profile: []       # goals, scope, owners, strategies, risks, current/planned boundary
  glossary: []             # business term, aliases, code name, ambiguity, counterexample
  entities: []             # fields/enums, relations, lifecycle/status, producers/consumers, invariants
  flows: []                # trigger, entry, stages, nodes, edges, outputs, exception/recovery
  entry_points: []         # page/bundle/http/rpc/thrift/mq/job -> repo/service/file/method
  service_facts: []        # deterministic code facts; keep separate from business semantics
  data_access: []          # table/cache/topic, readers/writers, query/path and verification source
  playbooks: []            # inputs, steps, checks, branches, rollback, stop conditions
  decisions: []            # choice, rationale, alternatives, owner/time, current/planned state
  lessons: []              # incident, impact, root cause, fix, recheck, recurrence signal
  gaps: []                 # missing evidence, impact, next source/task, status
  eval_cases: []           # query, expected answer/anchors, ground truth, pass criteria
```

Do not fill this package with invented fields. A section with no evidence stays empty or records `unknown`; it must not be replaced by a generic sentence. For a document with three or more populated business sections, `candidate_knowledge` must point to the package sections and preserve the original source locations. The package must be sufficient for a later Agent to produce an entry/chain lookup, a review checklist, a troubleshooting path, or a concrete gap task.

## Type-specific extraction routing

Before extracting, choose one or more `extraction_mode` values. Each mode has its own evidence and output contract:

- `fact/concept`: definition, aliases, fields/enums, version, boundary, counterexamples, conflicts;
- `entity`: relations, producers/consumers, lifecycle/state machine, invariants, verification anchors;
- `flow/entry`: trigger, page/API/RPC/job entry, ordered nodes/edges, states, exceptions, recovery and change boundaries;
- `service/data_fact`: code/graph facts only — method/file, caller/callee, table/cache/topic, reader/writer, commit;
- `decision`: context, problem, options, criteria, choice, rejected alternatives, impact, owner/time, current/planned state;
- `playbook`: preconditions, inputs, steps, checks, branches, observability, rollback, stop conditions;
- `lesson`: timeline, impact, root cause, gap, fix, recheck and recurrence signal;
- `goal/project`: goal, metric, milestone, owner, dependency, status and decision point;
- `review/writing`: source draft, comment, accept/reject, modification reason, final version and effect;
- `agent/experience`: goal, failure/block, correction, verifier, artifact, outcome and feedback;
- `person`: multi-view episode consolidation described below;
- `synthesis`: cross-source recurrence, disagreement, applicability and counterexamples.

The same Source may feed multiple modes, but each output keeps its own citations and confidence. Do not use a generic summary as a substitute for a missing mode-specific field.

Every draft handed to a human must include a visible `待确认` section with numbered items. Each item must say exactly which claim, scope, identity, applicability, sensitivity, or validation condition needs confirmation and what will change if confirmed. “请确认内容是否正确” is not an acceptable item. A draft without a concrete confirmation list stays in the Run Artifact and is not handed off as a reviewable Knowledge card.

## Person mode

When the request names a person, describe observable work patterns only:

For Elephant evidence, first use `./bin/ikb source person --name|--uid|--mis <speaker> --context-window 2` against already imported Sources. If the local view is empty, request or perform a bounded `source ingest-elephant` for an explicit chat/group target before expanding the range. Treat the returned record IDs and refs as the citations; do not perform a targetless global scan.

For a key person across sources, use `./bin/ikb people view <person-id> --scope <scope> --limit <n>` or `people rebuild`. This view joins only explicit identity evidence across Citadel documents/comments, Elephant messages, and Agent Sources; it is a rebuildable evidence view, not verified Knowledge. Cite the individual source IDs and record IDs from the view.

Read the dossier's `Attribution` field literally. `speaker`, `author`, `creator`, `owner`, and `modifier` are different evidence roles; `record_actor` means the adapter exposed an actor without enough role semantics; `context` is not attribution. A modifier may support a review/revision Episode but never proves sole authorship or ownership. If creator/owner/modifier disagree, preserve all roles in the Artifact and phrase the claim at the narrowest supported level.

The evidence view is only the first half of person extraction. Source intake is incremental; do not rebuild or distill a person after every record. At an intake checkpoint (or the scheduled daily evidence-view job), rebuild the deterministic dossier once for the affected scope. A batch rebuild must scan normalized Sources once per scope and distribute records to every selected person; do not rescan the corpus once per person. When a dossier is truncated, authored/owned/modified documents and review comments come first, then direct speech, then context-only records. Run person analysis/consolidation on a weekly window, or sooner only when there are at least three new direct episodes, two independent new Sources, or an explicit user request. The Artifact must compare the previous analysis window with the new evidence and report `added`, `unchanged`, `superseded`, `conflicted`, and `unknown` observations rather than silently replacing a profile.

- identity: MIS, UID, display name, aliases, and the exact identity evidence used;
- episodes: dated document, review, chat, or Agent episodes in which the person authored, decided, objected, owned, or supplied evidence;
- recurring topics: themes supported by at least three semantically independent episodes across at least two sources/source kinds and two dates, with record refs;
- decision criteria and constraints: what the person explicitly asked to protect, measure, or avoid;
- commitments and dependencies: explicit owner, TODO, handoff, or requested follow-up, with current status if known;
- observable communication or writing patterns: only repeated forms of work communication (for example, asks for evidence, scope, boundary, or rollout status), never personality or motive;
- writing patterns: repeated document choices such as structure, evidence placement, decision/unknown separation, or revision habits; require authored documents or accepted edits, never infer a general writing ability from one document;
- reusable capabilities: concrete work capabilities evidenced by outputs or repeated task episodes (for example, architecture framing, code review, incident analysis, technical writing, stakeholder communication, or cross-team coordination); record input, output, and conditions, never a skill score;
- interaction contract: the information, format, cadence, hand-off, or escalation path that repeatedly makes collaboration actionable; this is a working contract, not a personality label;
- unknowns and conflicts: identity ambiguity, one-off statements, unresolved comments, and stale or superseded claims;
- person_profile_candidates: zero or more small `entity`/`fact`/`playbook` candidates, each with an admission reason, applicability, boundary, and evidence refs.

Person mode must run separate views, not a single profile summary: identity/ownership, recurring domain and issue map, decision criteria, risk/quality bar, writing structure, review behavior, communication contract, execution/closure pattern, reusable capability, explicit collaboration edges, and temporal changes/contradictions. Each observation records `view`, `pattern`, `episodes`, `trigger`, `response_shape`, `usable_for`, `do_not_use_for`, `boundary`, `temporal_state`, counterevidence search, and confidence. “沟通好”“能力强”“比较严格” are not admissible statements. A view may remain evidence-only even when another view produces a Person draft.

Do not treat message counts, co-presence in a group, or being tagged as a contribution. A person candidate is eligible for `admit` only when the claim is explicit or repeated across independent episodes and can change a future interaction or decision. A single sentence remains evidence. Person dossiers remain rebuildable evidence views; admitted person Knowledge is a separate draft in the `people` collection and must never overwrite the dossier.

Use this deterministic candidate gate before proposing person Knowledge:

1. **Identity gate** — the author/sender/owner must match an exact registered MIS, UID, display name, or alias. Context-only participant or @mention evidence cannot establish the claim.
2. **Semantic recurrence gate** — a stable observation needs at least three semantically matching but context-independent direct Episodes across at least two Sources/source kinds and two dates. Adjacent comments, question/reply pairs, quoted or copied content, and multiple messages in one narrow thread count as one Episode. An explicitly documented durable rule may proceed only after user confirmation or a second independent direct source; the model cannot grant itself this exception.
3. **Actionability gate** — the observation must change a future interaction, review, plan, or decision; counts, generic praise, one-off status updates, and group co-presence fail this gate.
4. **Temporal gate** — record when the observation held and whether it is current, historical, superseded, or unresolved. A newer conflicting observation does not erase the old one.
5. **Inference gate** — state only observable topic, criterion, constraint, ownership, commitment, communication shape, writing pattern, or evidenced capability. Never infer personality, motive, loyalty, competence level, private life, or demographic attributes.
6. **Trace gate** — every sentence in a candidate must point to the exact Source/record or Artifact refs used to support it.
7. **Counterevidence gate** — search the same consolidation window for contradictory, updated, or superseding Episodes and record the search range even when none are found.
8. **Use-time gate** — record both `usable_for` and `do_not_use_for`; suppress the observation when it is irrelevant to the current task. If any gate fails, keep the material as `person_evidence_view` or `unknown` and emit `person_profile_candidates: []`.

- recurring goals and concerns;
- decision criteria and risk sensitivity;
- preferred communication shape and level of detail;
- writing structure and evidence placement when supported by authored or accepted documents;
- reusable work capabilities when the output and task context are directly evidenced;
- collaboration/hand-off contract: expected inputs, outputs, owner, timing, and escalation;
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

### Session Triage queue

Daily incremental intake and semantic analysis are separate steps. `./bin/ikb experience triage --scope work --adapter all` is a bounded pre-filter: it does not read complete tool output by default, does not produce Knowledge, and only queues sessions with a deterministic signal (an actually observed failure/block/retry, human correction, verifier rejection, non-obvious fix, `partial`/`incorrect` Knowledge feedback, or an explicit new decision/rule). Runtime/automation envelopes, embedded tool call/results, imported session markers, role-assignment prompts, ordinary task instructions, knowledge-evaluation subjects, explicit success/negation, and conditional descriptions such as “if the request fails” are not events. A previously queued record that becomes prompt-only after a rule correction is reconciled to `triageDisposition=ignored` and excluded from clustering; an Experience whose Source has left the active analysis plane is likewise reconciled to `ignored/source_outside_active_plane` without deleting the Source. Never preserve a false signal merely because its JSON already exists. Treat each selected item as an Experience Record with source/record/event/run references; it is a high-recall analysis queue, not a conclusion, so do not turn the signal label into a claim.

Weekly clustering may create a `pending_review` Knowledge Candidate only when the same pattern has 3 independent Runs, or 2 independent Runs plus one real verification/evaluation pass. If the Source-to-Run mapping is absent, keep the item in the analysis queue and do not count it as an independent Run. The Analyst must still read the cited evidence and produce a v2 Compilation with coverage, fact-backed claims, a type-specific consumer view, validation, confidence, and temporal state before Curator admission. A candidate is not retrievable Knowledge and must not be marked verified automatically.

## Output contract

Return:

```yaml
question: original analysis question
scope: personal|work
extraction_mode: [fact/concept|entity|flow/entry|service/data_fact|decision|playbook|lesson|goal/project|review/writing|agent/experience|person|synthesis]
evidence_refs: source and location references
episodes: grouped evidence with time bounds
findings:
  - statement
    kind: fact|inference|hypothesis|unknown
    evidence_refs: []
decisions: []
risks: []
open_questions: []
knowledge_dispositions:
  - source_refs: []
    decision: admit|skip
    reason: durable value or why no knowledge should be created
knowledge_compilation:
  schema: ikb-knowledge-compilation-result.v2
  evidence_units:
    - evidence_id: ""
      source_id: ""
      record_id: ""
      locator: ""
      excerpt: ""
      excerpt_sha256: ""
      attribution_role: speaker|author|creator|owner|modifier|reviewer|record_actor|system|context
      actor: ""
      occurred_at: ""
  facts:
    - fact_id: ""
      fact_kind: ""
      statement: ""
      evidence_ids: []
      derivation: direct|synthesis|inference
      temporal_state: current|historical|planned|superseded|conflicted|unknown
      importance: core|supporting|context
  coverage:
    - obligation_id: ""
      disposition: covered|omitted|unknown
      fact_refs: []
      reason: ""
  claims:
    - claim_id: ""
      text: ""
      claim_kind: direct_fact|attributed_statement|decision|synthesis|inference|unknown
      fact_refs: []
      counterevidence_fact_refs: []
      reasoning: ""
      temporal_state: current|historical|planned|superseded|conflicted|unknown
  products: [] # typed structures; never a free-form body-only product
candidate_knowledge:
  - statement
    suggested_type: fact|decision|preference|playbook|entity|goal
    suggested_collection: domains|projects|people|concepts|decisions|playbooks|lessons|syntheses
    quality_version: 4
    product_type: architecture_map|domain_pack|entity_card|flow_card|decision_card|playbook|lesson|project_goal|person_observation|synthesis
    compilation_ref: ""
    fact_refs: []
    questions_answered: []
    evidence_refs: []
    reasoning: ""
    applicability: ""
    execution_or_decision_path: ""
    use_contract: {} # required and structured only for playbook
    exceptions_or_failure_modes: []
    validation_plan: ""
    confirmation_items: []
    confidence:
      level: low|medium|high
      basis: []
    temporal_state: current|planned|historical|mixed|superseded|unknown
    person_confidence:
      identity: high
      pattern: medium
      independent_episode_count: 0
      independent_source_count: 0
      distinct_date_count: 0
      counterevidence_search: ""
      do_not_use_for: []
business_package:
  domain_profile: []
  glossary: []
  entities: []
  flows: []
  entry_points: []
  service_facts: []
  data_access: []
  playbooks: []
  decisions: []
  lessons: []
  gaps: []
  eval_cases: []
person_profile_candidates: []
person_observations:
  - view: identity|ownership|domain_map|decision_criteria|risk_bar|writing_pattern|review_behavior|communication_contract|execution_closure|capability|collaboration_edge|temporal_change|unknown
    pattern: ""
    episodes: []
    trigger: ""
    response_shape: ""
    usable_for: ""
    do_not_use_for: ""
    boundary: ""
    counterevidence_search: ""
    temporal_state: current|historical|superseded|conflicted|unknown
    confidence:
      level: low|medium|high
      basis: []
```

For a person-analysis Artifact, add this minimum per-person shape before proposing candidates:

```yaml
person:
  id: <key-person-id>
  identity_refs: []
  time_range: <from..to>
episodes: []
recurring_topics: []
decision_criteria: []
commitments: []
communication_patterns: []
writing_patterns: []
reusable_capabilities: []
interaction_contract: []
unknowns: []
person_profile_candidates: []
```

The human-readable Artifact must also include the matched count and source list from `people view`, the analysis window, and a comparison with the prior Artifact (`added`, `unchanged`, `superseded`, `conflicted`, `unknown`). This lets a later rebuild distinguish a new observation from a changed identity match. The Artifact is the handoff to Curator; it is not itself verified Knowledge.

Each candidate must point only to an `admit` disposition. A `skip` disposition must not be padded into a generic summary; pass it to the Curator so it can be recorded as a rejected Knowledge Candidate without creating a Vault note.

Do not mark candidates `verified` and do not send external communication. If the user asks for a document, communication draft, or review response, save it as an Artifact and keep the evidence refs alongside it.
