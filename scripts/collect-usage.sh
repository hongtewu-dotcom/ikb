#!/bin/bash
# IKB 使用反馈日采集；activation.json 存在时只采集 v2 新轮次。
# 由 launchd 每日触发（com.htwu.ikb-usage-collect.plist），纯本地脚本，零 LLM token。
# 手动跑：bash scripts/collect-usage.sh
set -u
NODE="${IKB_USAGE_NODE:-node}"
REPO="${IKB_USAGE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_ROOT="${IKB_USAGE_DATA_ROOT:-$REPO/ikb-data}"
USAGE_ROOT="$DATA_ROOT/usage"
if [ -d "$DATA_ROOT/usage-v2" ]; then echo "failure: migrate usage-v2 into usage before collecting" >&2; exit 1; fi
LOG="${IKB_USAGE_LOG:-$USAGE_ROOT/collect.log}"
cd "$REPO" || exit 1
mkdir -p "$(dirname "$LOG")" || exit 1
overall=0

run() {
  "$NODE" --no-warnings=ExperimentalWarning --experimental-strip-types "$@" 2>&1 | tail -1
  local code=${PIPESTATUS[0]}
  if [ "$code" -ne 0 ]; then
    echo "failure: $* exit=$code"
    overall=1
  fi
}

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
  if [ -f "$USAGE_ROOT/activation.json" ]; then
    SINCE=$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activatedAt' "$USAGE_ROOT/activation.json")
    if [ "$?" -ne 0 ] || [ -z "$SINCE" ] || [ "$SINCE" = "undefined" ]; then
      echo "failure: invalid v2 activation; collection stopped"
      exit 1
    fi
    run projects/eval-plane/src/ikb-recall-cli.ts collect-v2 --data-root "$DATA_ROOT"
    run projects/eval-plane/src/ikb-recall-cli.ts collect-pi --data-root "$DATA_ROOT"
    run projects/eval-plane/src/ikb-recall-cli.ts collect-claude --data-root "$DATA_ROOT"
    run scripts/ikb-feedback-import.mjs --usage-root "$USAGE_ROOT" --intake-root "$DATA_ROOT/intake" --cards-root "$DATA_ROOT/cards" --since "$SINCE"
    run projects/eval-plane/src/ikb-weekly-summary-cli.ts --v2 --usage-root "$USAGE_ROOT"
  else
    run projects/eval-plane/src/ikb-recall-cli.ts collect --data-root "$DATA_ROOT"
    run projects/eval-plane/src/ikb-recall-cli.ts collect-pi --data-root "$DATA_ROOT"
    run projects/eval-plane/src/ikb-recall-cli.ts collect-claude --data-root "$DATA_ROOT"
    run scripts/ikb-feedback-import.mjs --usage-root "$USAGE_ROOT" --intake-root "$DATA_ROOT/intake" --cards-root "$DATA_ROOT/cards"
    run projects/eval-plane/src/ikb-weekly-summary-cli.ts --usage-root "$USAGE_ROOT"
  fi

  echo "--- health ---"
  # 软链完整性：~/.catpaw/memory 必须是指向 ikb 的软链，MEMORY.md 必须是文件级软链
  # （CatDesk app 若原子替换覆盖软链，这里会第一时间发现）
  if [ -L "$HOME/.catpaw/memory" ]; then echo "health: memory symlink OK -> $(readlink "$HOME/.catpaw/memory")"; else echo "health: ALERT ~/.catpaw/memory 不是软链了！"; fi
  if [ -L "$HOME/.catpaw/memory/MEMORY.md" ]; then echo "health: MEMORY.md symlink OK"; else echo "health: ALERT MEMORY.md 软链丢失（可能被 app 覆盖）"; fi
  # 召回回归基线：只报结果行
  IKB_USAGE_PURPOSE=regression run --test test/ikb-cards-cli.test.ts test/ikb-cards-mcp.test.ts
  run scripts/ikb-workbench.mjs --intake-root "$DATA_ROOT/intake" --output-dir "$DATA_ROOT/intake/workbench"
} >> "$LOG" 2>&1

# 日志只留最近 200 行，防无限增长
tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
if [ "$?" -ne 0 ]; then overall=1; fi
exit "$overall"
