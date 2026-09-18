import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

// 每周汇总：把 usage/ 下的四类事实（召回统计、用户纠正、该查没查、注入日志）
// 收成一页吴鸿腾 5 分钟能扫完的文件。不做 dashboard，这就是全部产出。

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 跳过坏行
    }
  }
  return rows;
}

function hostOf(subjectRef: unknown): string {
  const match = typeof subjectRef === "string" ? /^run:\/\/([^/]+)\//.exec(subjectRef) : null;
  return match ? match[1] : "unknown";
}

function readV2Summary(usageRoot: string): Record<string, unknown> | null {
  const path = resolve(usageRoot, "summary.json");
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (value.schema !== "ikb-recall-usage-summary-v2" || value.version !== "v2") throw new Error("IKB usage v2 summary is invalid");
  return value;
}

function v2Timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return Date.parse(value);
}

/** Render only v2 evidence.  It never falls back to v1 summary or card paths. */
export function buildWeeklySummaryV2(usageV2Root: string, now: Date): string {
  const summary = readV2Summary(usageV2Root);
  const corrections = readJsonl(resolve(usageV2Root, "user-corrections.jsonl"));
  const missed = readJsonl(resolve(usageV2Root, "missed-lookup-candidates.jsonl"));
  const nowMs = now.getTime();
  const fromMs = nowMs - 7 * 86_400_000;
  const recent = (row: Record<string, unknown>): boolean => {
    const timestamp = v2Timestamp(row.detectedAt);
    return timestamp !== null && timestamp >= fromMs && timestamp <= nowMs;
  };
  const lines: string[] = ["# IKB 使用反馈周报（v2）", ""];
  if (!summary) {
    lines.push(`生成时间：${now.toISOString()} ｜ 口径：v2 尚未生成`, "", "- （无 v2 数据，先执行 collect-v2）", "", "数据源：usage/summary.json、usage/user-corrections.jsonl、usage/missed-lookup-candidates.jsonl");
    return `${lines.join("\n")}\n`;
  }
  const last7 = (summary.last7Days ?? {}) as Record<string, unknown>;
  const cumulative = (summary.cumulative ?? {}) as Record<string, unknown>;
  const outcomes = (last7.outcomes ?? {}) as Record<string, number>;
  const origins = (last7.origins ?? {}) as Record<string, number>;
  const cards = (last7.cards ?? {}) as Record<string, { reads?: number; references?: number; states?: Record<string, number> }>;
  const period = ((summary.window ?? {}) as Record<string, unknown>).last7DaysUtc as Record<string, string> | undefined;
  lines.push(`生成时间：${String(summary.generatedAt)} ｜ 最近 168 小时（UTC）：${period?.from ?? "unknown"} 至 ${period?.to ?? "unknown"}`, "", "> 样本按 attempt/search/read/state 分开统计；unknown 与失败保留，不推断交互质量。", "");
  lines.push("## 最近 7 天单位", "", `- attempts ${last7.attempts ?? 0}（success ${outcomes.success ?? 0} / failure ${outcomes.failure ?? 0} / missing ${outcomes.missing ?? 0} / invalid ${outcomes.invalid ?? 0} / unknown ${outcomes.unknown ?? 0}）`, `- searches ${last7.searches ?? 0}（zero-result ${last7.zeroResults ?? 0}）｜ reads ${last7.reads ?? 0} ｜ states ${last7.states ?? 0}`, "");
  lines.push("## 来源分桶", "");
  const originEntries = Object.entries(origins).sort(([a], [b]) => a.localeCompare(b));
  if (originEntries.length === 0) lines.push("- unknown（无数据）");
  else for (const [origin, count] of originEntries) lines.push(`- ${origin}：${count}`);
  lines.push("", "## 卡片读取与引用（最近 7 天）", "");
  const cardEntries = Object.entries(cards).sort(([a], [b]) => a.localeCompare(b));
  if (cardEntries.length === 0) lines.push("- 无");
  else for (const [cardId, card] of cardEntries) lines.push(`- ${cardId}：reads ${card.reads ?? 0} ｜ references ${card.references ?? 0}`);
  lines.push("", `## 用户纠正（最近 7 天 ${corrections.filter(recent).length} 条，累计 ${corrections.length} 条）`, "");
  if (corrections.length === 0) lines.push("- 无");
  else for (const row of corrections.filter(recent).slice(-20)) lines.push(`- [${String(row.label ?? "unknown")}｜candidate] ${String(row.excerpt ?? "").slice(0, 80)}`);
  lines.push("", `## 该查没查（最近 7 天 ${missed.filter(recent).length} 条，累计 ${missed.length} 条）`, "");
  if (missed.length === 0) lines.push("- 无");
  else for (const row of missed.filter(recent).slice(-20)) lines.push(`- ${String(row.excerpt ?? "").slice(0, 80)}`);
  lines.push("", `累计：attempts ${cumulative.attempts ?? 0} ｜ searches ${cumulative.searches ?? 0} ｜ reads ${cumulative.reads ?? 0} ｜ states ${cumulative.states ?? 0}`, "", "数据源：usage/summary.json、usage/user-corrections.jsonl、usage/missed-lookup-candidates.jsonl", "采集命令：collect-v2（显式激活后）");
  return `${lines.join("\n")}\n`;
}

// 原则卡 = cards/common/ + cards/work/practices/ 下的卡（判断辅助类，管"怎么想"）。
// 从卡片文件 frontmatter 的 id 字段取 cardId，与 usage/summary.json 的统计交叉。
function loadPrincipleCardIds(cardsRoot: string): Map<string, string> {
  const ids = new Map<string, string>(); // cardId -> 相对路径
  for (const sub of ["common", "work/practices"]) {
    const dir = resolve(cardsRoot, sub);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const path = resolve(dir, entry);
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const match = /^id:\s*(\S+)\s*$/m.exec(text);
      if (match) ids.set(match[1], `${sub}/${entry}`);
    }
  }
  return ids;
}

export function buildWeeklySummary(usageRoot: string, now: Date, cardsRoot?: string): string {
  const summaryPath = resolve(usageRoot, "summary.json");
  const summary = existsSync(summaryPath)
    ? (JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>)
    : null;
  const corrections = readJsonl(resolve(usageRoot, "user-corrections.jsonl"));
  const missed = readJsonl(resolve(usageRoot, "missed-lookup-candidates.jsonl"));
  const injects = readJsonl(resolve(usageRoot, "inject-log.jsonl"));

  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const recentCorrections = corrections.filter((r) => String(r.detectedAt ?? "") >= weekAgo);
  const recentMissed = missed.filter((r) => String(r.detectedAt ?? "") >= weekAgo);
  const recentInjects = injects.filter((r) => String(r.ts ?? "") >= weekAgo.replace(/-/g, "-"));

  const lines: string[] = [];
  lines.push("# IKB 使用反馈周报");
  lines.push("");
  lines.push(`生成时间：${now.toISOString()} ｜ 口径：最近 7 天 + 累计`);
  lines.push("");
  lines.push("> ⚠️ 样本量提醒：当前 n 小，采纳率类数字不作决策依据，只看趋势和具体条目。");
  lines.push("");

  lines.push("## 健康体检（软链 / 回归基线，异常才需要看）");
  lines.push("");
  const collectLogPath = resolve(usageRoot, "collect.log");
  const healthLines = existsSync(collectLogPath)
    ? readFileSync(collectLogPath, "utf-8").split("\n").filter((l) => l.startsWith("health:"))
    : [];
  // 回归测试成功行是“29 过 / 0 挂”，所以失败判定要看非零挂数
  const alerts = healthLines.filter((l) => l.includes("ALERT") || /[1-9]\d* 挂/.test(l));
  if (healthLines.length === 0) {
    lines.push("- （collect.log 无体检记录——定时任务可能没跑，检查 launchd）");
  } else if (alerts.length > 0) {
    for (const a of alerts.slice(-10)) lines.push(`- 🚨 ${a.replace(/^health: /, "")}`);
  } else {
    lines.push("- ✅ 最近一次体检全过（软链在位、回归测试全绿）");
  }
  lines.push("");

  lines.push("## 召回累计（Codex）");
  if (summary) {
    const states = (summary.states ?? {}) as Record<string, number>;
    lines.push(`- 检索 ${summary.recallCount} 次，读卡 ${summary.readCount} 次，零结果 ${summary.zeroResultCount} 次`);
    lines.push(`- 引用迹象 ${states.read_adopted ?? 0}（read_adopted，不代表工作有效）｜ 召回未读 ${states.recalled_not_read ?? 0} ｜ 明确拒绝 ${(states.explicitly_rejected_stale ?? 0) + (states.explicitly_rejected_incorrect ?? 0)}`);
  } else {
    lines.push("- （无数据，先跑 pnpm eval:ikb-recall）");
  }
  lines.push("");

  lines.push(`## 用户纠正（最近 7 天 ${recentCorrections.length} 条，累计 ${corrections.length} 条）`);
  lines.push("");
  if (recentCorrections.length === 0) {
    lines.push("- 无");
  } else {
    for (const r of recentCorrections.slice(-20)) {
      lines.push(`- [${r.label}｜${hostOf(r.subjectRef)}｜ikb=${r.hadIkbCall ? "有调用" : "无调用"}] ${String(r.excerpt ?? "").slice(0, 80)}`);
    }
  }
  lines.push("");
  lines.push("行动要求：纠正命中当天处理（补 aliases / 改卡 / 删误中词）。");
  lines.push("");

  lines.push("## 原则卡影响明细（本周 agent 的脑子被哪些原则碰过）");
  lines.push("");
  const principleIds = cardsRoot ? loadPrincipleCardIds(cardsRoot) : new Map<string, string>();
  if (principleIds.size === 0) {
    lines.push("- （未提供卡库路径，跳过）");
  } else if (summary) {
    const cardStats = (summary.cards ?? []) as Array<{ cardId: string; evaluationCount: number; states: Record<string, number> }>;
    const touched = cardStats.filter((c) => principleIds.has(c.cardId));
    if (touched.length === 0) {
      lines.push(`- 本周无原则卡被召回/引用（库内共 ${principleIds.size} 张原则卡）`);
    } else {
      for (const c of touched) {
        const adopted = c.states.read_adopted ?? 0;
        const notRead = c.states.recalled_not_read ?? 0;
        const rejected = (c.states.explicitly_rejected_stale ?? 0) + (c.states.explicitly_rejected_incorrect ?? 0);
        lines.push(`- ${principleIds.get(c.cardId)}：引用迹象 ${adopted} ｜ 召回未读 ${notRead} ｜ 拒绝 ${rejected}`);
      }
      lines.push("");
      lines.push("引用仅是审查线索；是否改变判断、是否有益，仍须核对实际任务结果。");
    }
  }
  lines.push("");

  lines.push(`## 该查没查（待审清单，最近 7 天新增 ${recentMissed.length} 条，清单共 ${missed.length} 条）`);
  lines.push("");
  for (const r of missed.slice(-10)) {
    lines.push(`- ${String(r.detectedAt ?? "").slice(0, 16)} ${String(r.excerpt ?? "").slice(0, 70)}`);
  }
  if (missed.length === 0) lines.push("- 无");
  lines.push("");

  lines.push(`## 注入记账（最近 7 天 ${recentInjects.length} 次，累计 ${injects.length} 次）`);
  lines.push("");
  if (recentInjects.length > 0) {
    const cardHits = new Map<string, number>();
    for (const r of recentInjects) {
      for (const c of (r.cards ?? []) as Array<{ card?: string }>) {
        if (c.card) cardHits.set(c.card, (cardHits.get(c.card) ?? 0) + 1);
      }
    }
    for (const [card, count] of [...cardHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      lines.push(`- ${card} × ${count}`);
    }
    lines.push("");
    lines.push("误中判断：命中但跟消息主题无关的，删路由表对应关键词。");
  } else {
    lines.push("- 无（注入通道还没产生记录）");
  }
  lines.push("");
  lines.push("---");
  lines.push("数据源：usage/summary.json、user-corrections.jsonl、missed-lookup-candidates.jsonl、inject-log.jsonl");
  lines.push("采集命令：pnpm eval:ikb-recall（Codex 全量）/ eval:ikb-recall-pi / eval:ikb-recall-claude（纠正增量）");
  return `${lines.join("\n")}\n`;
}

export function runIkbWeeklySummaryCli(argv: string[], io: Pick<typeof process, "stdout" | "stderr"> = process): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const defaultUsageRoot = resolve(repoRoot, "ikb-data", "usage");
  let usageRoot = defaultUsageRoot;
  let outPath = resolve(usageRoot, "weekly-summary.md");
  let v2 = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--usage-root" && next) {
      usageRoot = resolve(next);
      if (outPath === resolve(defaultUsageRoot, "weekly-summary.md")) outPath = resolve(usageRoot, "weekly-summary.md");
      index += 1;
    } else if (arg === "--out" && next) {
      outPath = resolve(next);
      index += 1;
    } else if (arg === "--v2") {
      v2 = true;
    } else {
      io.stderr.write(`unsupported argument: ${arg}\n`);
      return 1;
    }
  }
  if (v2 || existsSync(resolve(usageRoot, "activation.json"))) {
    const v2Root = usageRoot;
    if (outPath === resolve(usageRoot, "weekly-summary.md")) outPath = resolve(v2Root, "weekly-summary.md");
    const content = buildWeeklySummaryV2(v2Root, new Date());
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
    io.stdout.write(`${JSON.stringify({ schema: "ikb-weekly-summary-v2", out: outPath, bytes: content.length })}\n`);
    return 0;
  }
  const content = buildWeeklySummary(usageRoot, new Date(), resolve(repoRoot, "ikb-data", "cards"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
  io.stdout.write(`${JSON.stringify({ schema: "ikb-weekly-summary-v1", out: outPath, bytes: content.length })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runIkbWeeklySummaryCli(process.argv.slice(2));
}
