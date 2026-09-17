import { buildStockMetrics } from "./ikb-workbench-stock.mjs";
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DAY = 86400000;
const number = value => Number.isInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function buildWorkbenchMetrics({ requests, historicalIds = [], decisionIds, intakeRoot, cardsRoot = join(dirname(intakeRoot), "cards"), generatedAt }) {
  const now = Date.parse(generatedAt);
  const history = new Set(historicalIds);
  const current = requests.filter(item => !history.has(item.requestId));
  const terminal = new Set(['completed', 'no_change', 'excluded']);
  const waiting = current.filter(item => !terminal.has(item.status) && (decisionIds ? decisionIds.includes(item.requestId) : item.decision?.required));
  const ages = waiting.map(item => timestamp(item.decision?.recordedAt)).filter(time => time !== null && time <= now);
  const updated = new Set(), previous = new Set();
  let unplacedCompletions = 0;
  for (const item of current) {
    if (item.status !== 'completed' || item.artifacts?.complete !== true) continue;
    const final = item.artifacts.final;
    const time = timestamp(final?.completedAt);
    if (time === null || time > now) { unplacedCompletions++; continue; }
    const bucket = time >= now - 7 * DAY ? updated : time >= now - 14 * DAY ? previous : null;
    if (bucket) for (const change of final.changes ?? []) {
      if (typeof change.cardId === 'string' && typeof change.afterHash === 'string') bucket.add(change.cardId);
    }
  }
  const feedback = current.filter(item => item.request?.kind === 'feedback');
  const usagePath = join(dirname(intakeRoot), 'usage-v2', 'summary.json');
  let usage = { state: 'missing', sourcePath: usagePath, reason: '尚无使用统计', reads: null, searches: null, references: null };
  if (existsSync(usagePath)) {
    try {
      if (!lstatSync(usagePath).isFile() || lstatSync(usagePath).isSymbolicLink()) throw Error('统计来源不是普通文件');
      const data = JSON.parse(readFileSync(usagePath, 'utf8'));
      const period = data.window?.last7DaysUtc;
      const counts = data.last7Days;
      const time = timestamp(data.generatedAt);
      if (data.schema !== 'ikb-recall-usage-summary-v2' || time === null || time > now || !number(counts?.reads) || !number(counts?.searches) || !number(counts?.zeroResults) || timestamp(period?.from) === null || timestamp(period?.to) === null || Date.parse(period.from) > Date.parse(period.to) || Date.parse(period.to) > now) throw Error('统计格式或时间不完整');
      const cards = Object.values(counts.cards ?? {});
      const references = counts.cards && typeof counts.cards === 'object' && cards.every(card => number(card.references)) ? cards.reduce((sum, card) => sum + card.references, 0) : null;
      usage = { state: now - time > 36 * 3600000 ? 'stale' : 'available', sourcePath: usagePath, generatedAt: data.generatedAt, window: period, reads: counts.reads, searches: counts.searches, zeroResults: counts.zeroResults, references, origins: counts.origins ?? {}, note: '已采集的全部流量，含维护和测试；查阅或引用不代表有效。' };
    } catch (error) {
      usage = { ...usage, state: 'invalid', reason: `使用统计读取失败：${error.message}` };
    }
  }
  return {
    asOf: new Date(Math.floor(now / 60000) * 60000).toISOString(),
    decisions: { pending: waiting.length, oldestHours: ages.length ? Math.floor((now - Math.min(...ages)) / 3600000) : null, unknownAge: waiting.length - ages.length },
    knowledge: { days: 7, updatedCards: updated.size, previous7Days: previous.size, change: updated.size - previous.size, unplacedCompletions, cardIds: [...updated] },
    feedback: { total: feedback.length, handled: feedback.filter(item => terminal.has(item.status)).length, deferred: feedback.filter(item => item.status === 'waiting').length, pending: feedback.filter(item => !terminal.has(item.status) && item.status !== 'waiting').length },
    usage,
    stock: buildStockMetrics({ cardsRoot, intakeRoot, generatedAt, classifications: current.filter(item => item.status === 'completed' && item.artifacts?.complete).flatMap(item => (item.artifacts.plan?.changes ?? []).map(change => ({ cardId: change.cardId, kind: change.knowledgeKind, contentHash: item.artifacts.final?.changes?.find(actual => actual.cardId === change.cardId)?.afterHash }))) }),
  };
}
