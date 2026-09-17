# IKB 当前会话原生执行合同

> 此为完整本机维护环境的合同参考。公开快照仅提供请求登记和读取；维护执行脚本及私有回归集未分发，不能仅凭本快照完成正式发布。

The current conversation's main Agent owns this request. Submission only saves
local records and returns execution metadata; it never starts a process or a
second model session. The main Agent directly uses the host's native subagent
tool to delegate an isolated author task. After accepting that handoff, it
uses a separate native consumer to run the independent trial. The current
main Agent reviews and is the only role that may approve and publish.

Use requestId, requestPath, workspace and contractPath returned in execution.
Read the immutable request with `ikb request status REQUEST_ID --intake-root
INTAKE_ROOT`; preserve its actual source identity and snapshots. A subagent
receives only its exact write scope, request path and required evidence.
Never run a request worker, detached shell, codex exec, or another model CLI.
If the conversation ends, retain the request/workspace and resume explicitly
in the next host conversation. Native subagent IDs and waits are owned by the
host, not synthesized by the CLI. Missing native subagent support is a
reported limitation, not a reason to create a fallback runtime.

Treat `request.acceptance` as an immutable acceptance contract. Preserve every
original positive and negative query exactly; never delete or replace the
request's original question. You may add independent queries when they test a
distinct behavior, but the original question must remain in the positive set.
When source documents disagree, do not dismiss an observed result solely
because one document is newer. Without same-layer, same-version evidence,
preserve the conflict and record `defer` with the concrete missing evidence.
Request status remains program-derived from the recorded workspace and final
artifacts; prompts and events cannot declare completion.

Before choosing command arguments, read the live deterministic contracts:

```sh
node scripts/knowledge-maintenance.mjs --help
node scripts/knowledge-maintenance.mjs admission-help
```

Prepare one isolated request workspace using the exact `prepare-request`
syntax printed by `--help`, with `request:<REQUEST_ID>` as its only request
member. That command records the workspace binding. Use `admission-help` above for
the exact evidence contract; there is no separate gate executable.

Use existing `record` and `stage` commands to preserve the maintenance
inventory and isolated snapshots. The request author may write only inside
the request workspace. Never edit `ikb-data/cards` or another active cards
root directly. `targetCardId` authorizes a modify of that card; without a
target, the request can propose one add from the explicit update intent.
Archive, personal, and principle changes require their own approved path and
review; they are outside this request's automatic authorization.

The root Agent must review source evidence, old/new claims, conflicts, and the
independent consumer trial. Use `plan-request --workspace DIR --draft FILE`
to stage the request draft and generate the deterministic `request-plan.json`
with request identity, paths, authorization and card IDs. Build the
assessment and review plan required by `admission-help`, then run `admit` and
use the generated v2 admitted plan. Run
the deterministic check-only publication first, publish only after that check
passes, and run `finalize` for the real default CLI search/get and final
verification. Publication and final verification are separate facts.

Do not report `published` or `completed` from a prompt or event. The request
status is derived by the request module from the workspace publication receipt
and `ikb-final-verification-v1`. Preserve every failure and concrete pending
reason. If this run cannot continue, record it before exiting:

```sh
node --input-type=module - "$REQUEST_ID" "$INTAKE_ROOT" "$REASON" <<'JS'
import { recordRequestEvent } from './scripts/ikb-requests.mjs';
const [id, intakeRoot, reason] = process.argv.slice(2);
recordRequestEvent(id, { type: 'failed', reason }, { intakeRoot });
JS
```

Submission returns immediately. The current main Agent waits for native completion receipts, not a background process or a result-directory polling loop. It can continue unrelated user work while a native subagent runs.

长期主题积累：当本请求涉及已存在的人物或跨任务主题，当前主 Agent 按 主题框架约定 定位 `ikb-data/intake/maintenance/topic-frameworks/index.md` 中语义匹配的框架。只将必要维度和来源位置交给作者，作者仍只能写本请求 workspace；观察与归纳建议先留在作者工作区，由主 Agent 接受后归并到共享框架，不能突破子 Agent 写域。主题不存在且确有跨会话用途时才按模板初始化；新材料可以填入框架而暂不产卡。保持原始验收问题和请求范围，不因框架还有空维度而扩大请求、外采或重开存量。框架不替代活动卡、原始证据、request status 或发布回执。

工作区固定为 <intakeRoot>/maintenance/requests/<requestId>；不另选恢复目录。读取 `ikb-data/CONSUMING.md` 和完整方案 S02—S13，主审须遵守相同规则。运行中只检查具体来源与该请求，禁止扫描历史全量、读取自己的运行事件作为知识素材。原始后台事件只用于运行身份验收。

涉及写作风格、沟通/行为方式或主题方法时，作者按[case模板](../docs/topic-framework/templates/case.md)提供原始样本、情境、具体做法、参考方式和边界；主 Agent 接受后归并框架 `cases.md`，使汇总能回到 case。没有原始前后稿不编造，AI生成内容不直接归属本人文风。

主 Agent 完成本轮手动处置或发布验收后，运行 `node scripts/ikb-workbench.mjs --intake-root <本请求intakeRoot> --output-dir <本请求intakeRoot>/workbench` 刷新只读工作台。刷新失败单列为报告失败，不改写知识发布回执；页面上的处理指令仍需在当前会话重读当前版本执行，不直接审批。

Usage provenance: prefix maintenance lookup commands with `IKB_USAGE_PURPOSE=maintenance`; independent acceptance searches/gets use `IKB_USAGE_PURPOSE=regression`. These mark the actual command purpose for usage accounting, not user knowledge or proof of quality. A lookup without an explicit marker stays unknown. Never label an acceptance trial interactive to improve the daily-use numbers.


## 必须由用户决定的事项：实时工作台入口

仅在缺少用户掌握的信息、超出已有授权的范围选择、原则具体差异或证据无法裁决的选择时上报；普通待主审、技术失败和 Agent 可自行补证不算用户决策。遇到这些情况，先把当前对象关联到现有 request（增量主题没有 request 时走 feedback 入口，保留真实来源和身份），再执行 `ikb request decision <requestId> --input <JSON文件> [--intake-root DIR]`。不能只在聊天或自由文本 report 中写“等用户”。

提出问题的输入：`{"action":"ask","question":"要你决定的问题","difference":"具体差异及影响","options":["选项A","选项B"],"recommendation":"建议及原因","reference":"真实问题或改稿依据的本地路径，可带#line=N"}`。CLI 生成 decisionId 并保存来源副本；问题变化重新 ask，不能沿用旧版本。记录仍在原 request 的 events.jsonl 中，不新建待办状态库。

用户在当前会话明确回应后，核对与展示版本一致，再执行同一入口：`{"action":"resolve","expectedDecisionId":"当前decisionId","answer":"用户的实际选择","reference":"用户实际回应的本地来源路径，可带#line=N"}`。过期版本会拒绝；没有真实回应不得代填，超时不是同意。resolve 只表示问题已回答，不代替准入、发布或最终验收。之后由当前主 Agent 原生续跑，不启动新的模型进程。

实时工作台读取这些回执；浏览器打开时约每 5 秒更新一次。此频率只是展示数据轮询，不是新知识扫描或 Agent 执行轮询。原有定时采集频率不变。


## 给用户看的工作台文案

工作台首页只突出需要用户做的选择、已完成的知识更新和用户指定的人物。运行日志、补证任务、主审过程属于内部记录，不能要求用户“核对回执”“定位恢复条件”。确需用户参与时，使用前述 decision 入口写清问题、选项、影响和建议。

需要说明内部事项时，可用现有 `recordRequestEvent` 的 `report` 事件附带 `presentation: {title, summary}`：title 是简短事项名，summary 用自然语言说清当前结果和是否需要用户操作。它仅解释原记录，不改变请求状态、完成条件或用户授权；原始 question、证据和错误日志保留供排查。没有新的用户行动，不要用“下一步”把 Agent 的工作转交给用户。

人物收集优先遵循维护区 `topic-frameworks/people-scope.json` 的用户指定名单；空名单且 status=awaiting_original_list 表示名单缺失，不表示用户没有重点人物。不得从已有卡片数量推导用户优先级；未列名人物可补充积累，但不能挤占指定人物或冒充原名单。
