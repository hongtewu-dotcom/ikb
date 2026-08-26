---
name: multi-reviewer-patterns
description: Coordinate bounded parallel code reviews on a frozen snapshot with a reader-repair barrier, finding deduplication, severity calibration, and one final verifier. Use this skill when organizing multi-reviewer code reviews, preventing review and repair from racing, or consolidating review results.
metadata:
  version: 1.2.0
---

# Multi-Reviewer Patterns

Patterns for coordinating parallel code reviews across multiple quality dimensions, deduplicating findings, calibrating severity, and producing consolidated reports.

## When to Use This Skill

- Organizing a multi-dimensional code review
- Deciding which review dimensions to assign
- Deduplicating findings from multiple reviewers
- Calibrating severity ratings consistently
- Producing a consolidated review report

## Review Barrier

Resolve all reviewers to the same frozen snapshot: an exact commit, diff range, content hash, or working-tree snapshot id. Pass references and file scope instead of copying the entire diff into the parent context.

Every reviewer prompt must freeze `goal`, `scope`, `acceptance`, and `handoff`. The handoff contains status, verdict, snapshot id, structured findings, and uncovered scope; acceptance requires complete inspection of the assigned scope with exact evidence or an explicit no-findings result.

Spawn only read-only reviewers and keep the Review Barrier closed until every reader completes, blocks, or is terminated after narrowing guidance fails to restore observable progress. Do not start repairs from the first returned finding. After the reader join:

1. separate `status=completed|blocked` from `verdict=pass|block`;
2. deduplicate and calibrate all findings;
3. apply one consolidated repair batch through one owner;
4. freeze a new snapshot and run only affected incremental dimensions;
5. after two review-repair rounds, re-evaluate root cause, scope, and strategy; continue only when the next round tests a materially different in-scope fix;
6. run one final verifier against the latest snapshot and original blocking criteria.

On Codex, select model and effort per frozen dimension: Luna `medium` for a narrow deterministic evidence check, Terra `medium` for a standard dimension, and Terra `high` for security, concurrency, cross-module architecture, or another high-risk dimension. Keep deduplication, severity arbitration, and the final quality decision in the root parent. Use `xhigh` only after representative evaluation shows a clear gain.

The root parent owns reviewer routing. Call `list_agents` first and use `followup_task` only for an idle reviewer with the same frozen snapshot, same review dimension, same role, model, effort, and scope, after its prior result was accepted; otherwise use `spawn_agent`. Track `reuse_count` for diagnostics only; it never makes an otherwise compatible reviewer ineligible. Use the installed reviewer only for its fixed Terra-medium route; for other routes use built-in `explorer` with the selected `model` and `reasoning_effort`. Model overrides require isolated or bounded history, so use `fork_context: false` on V1/App or `fork_turns: "none"` on MultiAgentV2/CLI unless a minimum supported recent-history fork is essential. Treat a reviewer as started only after `spawn_agent` returns a nonempty agent id. Call `wait_agent` only while that child is active without a handoff; an arrived handoff satisfies the join. Use a bounded `wait_agent` at the join, `send_message` to correct a running reviewer, change approach when the same failure repeats without progress, and `interrupt_agent` when a running branch must stop. Legacy hosts may expose `send_input` and `close_agent` as equivalent controls. Reviewer completion never implies a passing quality verdict.

Use at most four concurrent reviewers in one wave. Preserve every requested review dimension; when more than four independent dimensions are requested, run additional waves rather than combining or dropping coverage. Reuse a compatible idle reviewer when possible, but do not impose fixed total-spawn or wait-count limits that can block completion. Reviewers return uncovered scope to the parent and never create their own review tree. Each reviewer returns a concise handoff covering `status`, `summary`, `evidence`, `changes`, `validation`, and `gaps`; JSON is optional and bulky evidence belongs in artifacts.

## Review Dimension Allocation

### Available Dimensions

| Dimension         | Focus                                   | When to Include                             |
| ----------------- | --------------------------------------- | ------------------------------------------- |
| **Security**      | Vulnerabilities, auth, input validation | Always for code handling user input or auth |
| **Performance**   | Query efficiency, memory, caching       | When changing data access or hot paths      |
| **Architecture**  | SOLID, coupling, patterns               | For structural changes or new modules       |
| **Testing**       | Coverage, quality, edge cases           | When adding new functionality               |
| **Accessibility** | WCAG, ARIA, keyboard nav                | For UI/frontend changes                     |

### Recommended Combinations

| Scenario               | Dimensions                                   |
| ---------------------- | -------------------------------------------- |
| API endpoint changes   | Security, Performance, Architecture          |
| Frontend component     | Architecture, Testing, Accessibility         |
| Database migration     | Performance, Architecture                    |
| Authentication changes | Security, Testing                            |
| Full feature review    | Security, Performance, Architecture, Testing |

## Finding Deduplication

When multiple reviewers report issues at the same location:

### Merge Rules

1. **Same file:line, same issue** — Merge into one finding, credit all reviewers
2. **Same file:line, different issues** — Keep as separate findings
3. **Same issue, different locations** — Keep separate but cross-reference
4. **Conflicting severity** — Use the higher severity rating
5. **Conflicting recommendations** — Include both with reviewer attribution

### Deduplication Process

```
For each finding in all reviewer reports:
  1. Check if another finding references the same file:line
  2. If yes, check if they describe the same issue
  3. If same issue: merge, keeping the more detailed description
  4. If different issue: keep both, tag as "co-located"
  5. Use highest severity among merged findings
```

## Severity Calibration

### Severity Criteria

| Severity     | Impact                                        | Likelihood             | Examples                                     |
| ------------ | --------------------------------------------- | ---------------------- | -------------------------------------------- |
| **Critical** | Data loss, security breach, complete failure  | Certain or very likely | SQL injection, auth bypass, data corruption  |
| **High**     | Significant functionality impact, degradation | Likely                 | Memory leak, missing validation, broken flow |
| **Medium**   | Partial impact, workaround exists             | Possible               | N+1 query, missing edge case, unclear error  |
| **Low**      | Minimal impact, cosmetic                      | Unlikely               | Style issue, minor optimization, naming      |

### Calibration Rules

- Security vulnerabilities exploitable by external users: always Critical or High
- Performance issues in hot paths: at least Medium
- Missing tests for critical paths: at least Medium
- Accessibility violations for core functionality: at least Medium
- Code style issues with no functional impact: Low

## Consolidated Report Template

```markdown
## Code Review Report

**Target**: {files/PR/directory}
**Reviewers**: {dimension-1}, {dimension-2}, {dimension-3}
**Date**: {date}
**Files Reviewed**: {count}
**Snapshot**: {commit/diff/hash}
**Verdict**: pass | block

### Critical Findings ({count})

#### [CR-001] {Title}

**Location**: `{file}:{line}`
**Dimension**: {Security/Performance/etc.}
**Description**: {what was found}
**Impact**: {what could happen}
**Fix**: {recommended remediation}

### High Findings ({count})

...

### Medium Findings ({count})

...

### Low Findings ({count})

...

### Summary

| Dimension    | Critical | High  | Medium | Low   | Total  |
| ------------ | -------- | ----- | ------ | ----- | ------ |
| Security     | 1        | 2     | 3      | 0     | 6      |
| Performance  | 0        | 1     | 4      | 2     | 7      |
| Architecture | 0        | 0     | 2      | 3     | 5      |
| **Total**    | **1**    | **3** | **9**  | **5** | **18** |

### Recommendation

{Overall assessment and prioritized action items}
```
