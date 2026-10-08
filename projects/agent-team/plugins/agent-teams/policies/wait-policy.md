# Wait for branch feedback

## Parent behavior

Continue independent parent work while a branch runs. At a real dependency join,
wait for the required branch handoff before consuming its output. Do not repeatedly
inspect agent status, logs, directories, or intermediate artifacts merely to confirm
that work is still running. Do not repeat or take over the branch scan while waiting.

Prefer native event-driven waiting. Request a 300-second wait where supported,
capped by the host tool limit and any stricter session constraint (for example,
60 seconds). Use the native asynchronous wait when available so user input and
required progress updates remain responsive. A wait timeout only ends that waiting
window: it is not a task failure, permission to retry, or a reason to interrupt.
If no actionable event arrives, wait again without an extra status scan.

A progress message is not a terminal handoff. Handle a concrete question or blocker,
then continue waiting for still-required branches. An observed terminal status or
final handoff ends the wait for that branch; check its receipt and evidence before
accepting it. Do not begin dependent integration or review synthesis until all
required branches have handed off or been explicitly stopped with gaps recorded.
A terminal partial/blocked result must remain visible, not become accepted success.

Intervene on a reported blocker, decision request, explicit host failure, or concrete
scope/safety violation. Use the existing branch contract and risk-driven checkpoints
for semantic concerns; vague worry does not justify periodic log review. Do not add
checkpoints to every task. Give user-facing updates when required, without querying
a branch just to produce update text. Never turn wait counts into completion gates.

## Host adapters

- Codex: use native wait/message/interrupt tools. Do not wrap them in shell polling
  or scan session files to imitate lifecycle events. Tool names and availability
  come from the current host. Only inspect status when a concrete missing or
  inconsistent handoff needs reconciliation.
- Pi: let workflow code await `agent()` and `parallel()`; do not start extra model
  calls to check whether pending promises have finished. Preserve runtime failures
  and receipt validation through the existing workflow paths. An await is not a
  new per-call execution deadline; retain existing task timeout/cancellation rules.
- Only an adapter with no usable event/wait interface may implement polling. Keep
  it in code using the host's supported status interface, bounded backoff and the
  existing task deadline; report terminal results or actionable exceptions, not
  unchanged snapshots. Do not add a new runtime, heartbeat, queue, or permanent
  watcher. The current Codex and Pi adapters need no polling loop.
