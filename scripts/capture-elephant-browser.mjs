#!/usr/bin/env node

/**
 * Capture one explicitly selected Elephant group from the existing CatDesk
 * browser tab.  The default completion condition is the page's own
 * "no-more-messages" state; there is no arbitrary 100-record cap.
 *
 * This is an evidence capture helper, not an ingest command.  It only uses
 * navigate, wait, evaluate and the message-pane load-more control.  It never
 * touches the composer or any write-capable Elephant action.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_CATDESK = "/Applications/CatDesk.app/Contents/Resources/bin/catdesk";
const DEFAULT_WAIT_MS = 1_200;
const DEFAULT_STALL_RETRIES = 4;
const TEXT_PREVIEW_CHARS = 512;
const TEXT_CHUNK_CHARS = 1_500;
const CAPTURE_DATE = process.env.IKB_CAPTURE_DATE ?? new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
}).format(new Date());

function usage() {
  console.error(`Usage: capture-elephant-browser.mjs --gid <gid> --output <ndjson> [options]

Options:
  --name <name>              Group display name (defaults to gid)
  --max-records <n>          Optional explicit partial-capture bound
  --wait-ms <n>              Wait between browser actions (default: ${DEFAULT_WAIT_MS})
  --stall-retries <n>        Retries before reporting a stalled page (default: ${DEFAULT_STALL_RETRIES})
  --catdesk <path>           CatDesk CLI path
  --current                  Reuse the already selected matching group page
  --debug                    Print pagination state to stderr
  --help                     Show this help

Without --max-records the helper keeps loading until the page no longer exposes
the message-pane “加载更多” control. Existing output files are never overwritten.`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { gid: "", name: "", output: "", maxRecords: null, waitMs: DEFAULT_WAIT_MS, stallRetries: DEFAULT_STALL_RETRIES, catdesk: DEFAULT_CATDESK, current: false, debug: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") usage();
    const next = () => argv[++index];
    if (arg === "--gid") options.gid = String(next() ?? "").trim();
    else if (arg === "--name") options.name = String(next() ?? "").trim();
    else if (arg === "--output") options.output = String(next() ?? "").trim();
    else if (arg === "--max-records") options.maxRecords = Number(next());
    else if (arg === "--wait-ms") options.waitMs = Number(next());
    else if (arg === "--stall-retries") options.stallRetries = Number(next());
    else if (arg === "--catdesk") options.catdesk = String(next() ?? "").trim();
    else if (arg === "--current") options.current = true;
    else if (arg === "--debug") options.debug = true;
    else usage();
  }
  if (!/^\d{1,32}$/.test(options.gid)) throw new Error("--gid must be a numeric Elephant group id");
  if (!options.output) throw new Error("--output is required; existing evidence must never be overwritten");
  if (options.maxRecords !== null && (!Number.isInteger(options.maxRecords) || options.maxRecords < 1)) {
    throw new Error("--max-records must be a positive integer");
  }
  if (!Number.isInteger(options.waitMs) || options.waitMs < 100) throw new Error("--wait-ms must be at least 100");
  if (!Number.isInteger(options.stallRetries) || options.stallRetries < 1) throw new Error("--stall-retries must be positive");
  options.name ||= options.gid;
  options.output = resolve(options.output);
  return options;
}

function debug(options, message, details = undefined) {
  if (!options.debug) return;
  console.error(`[capture-elephant-browser] ${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
}

function action(options, payload, timeoutMs = 120_000) {
  const stdout = execFileSync(options.catdesk, ["browser-action", JSON.stringify(payload)], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const envelope = JSON.parse(stdout);
  if (envelope.success === false) throw new Error(envelope.error ?? "CatDesk browser action failed");
  return envelope.data?.result;
}

function evaluate(options, script) {
  return action(options, { action: "evaluate", script });
}

function wait(options, milliseconds) {
  action(options, { action: "wait", timeout: milliseconds }, Math.max(10_000, milliseconds + 10_000));
}

function pageState(options) {
  return evaluate(options, `(() => {
    const elements = [...document.querySelectorAll('.bubbleMessageListContainer .bubble-item')];
    const control = document.querySelector('.bubbleMessageListContainer .wrapper-loading.load-more');
    return {
      href: location.href,
      rows: elements.length,
      firstMid: elements[0]?.getAttribute('data-mid') || '',
      lastMid: elements.at(-1)?.getAttribute('data-mid') || '',
      loadMoreText: control?.innerText?.trim() || '',
      hasLoadMore: Boolean(control),
    };
  })()`);
}

function clickLoadMore(options) {
  return Boolean(evaluate(options, `(() => {
    const control = document.querySelector('.bubbleMessageListContainer .wrapper-loading.load-more');
    if (!control) return false;
    control.click();
    return true;
  })()`));
}

function decodeBase64(value) {
  return Buffer.from(String(value), "base64").toString("utf8");
}

function extractDomTextChunk(options, row, field, start) {
  const mid = String(row.mid ?? "");
  const domIndex = Number(row.__domIndex ?? 0);
  const midLiteral = JSON.stringify(mid);
  const encoded = evaluate(options, `(() => {
    const elements = [...document.querySelectorAll('.bubbleMessageListContainer .bubble-item')];
    const element = ${mid ? `elements.find((candidate) => candidate.getAttribute('data-mid') === ${midLiteral})` : `elements[${domIndex}]`};
    const message = [...(element?.querySelectorAll('.dx-message-text') || [])].at(-1);
    const value = ${field === "raw" ? "(element?.textContent || element?.innerText || '')" : "(message?.textContent || message?.innerText || '')"};
    return btoa(unescape(encodeURIComponent(value.slice(${start}, ${start + TEXT_CHUNK_CHARS}))));
  })()`);
  return decodeBase64(encoded);
}

function hydrateLongText(options, row, field, compact) {
  const length = Number(compact?.length ?? 0);
  const preview = String(compact?.preview ?? "");
  if (preview.length >= length) return preview.slice(0, length);
  let value = preview;
  for (let start = preview.length; start < length;) {
    const part = extractDomTextChunk(options, row, field, start);
    if (!part) throw new Error(`Unable to read complete ${field} text for message ${row.mid || row.uuid || row.__domIndex}`);
    value += part;
    start += part.length;
  }
  return value.slice(0, length);
}

function hydrateRows(options, compactRows, start) {
  return compactRows.map((row, offset) => {
    const hydrated = { ...row, __domIndex: start + offset };
    hydrated.content = hydrateLongText(options, hydrated, "content", row.content);
    hydrated.raw = hydrateLongText(options, hydrated, "raw", row.raw);
    return hydrated;
  });
}

function extractChunk(options, start, requestedSize) {
  let size = requestedSize;
  while (size >= 1) {
    try {
      const encoded = evaluate(options, `(() => {
        const rows = [...document.querySelectorAll('.bubbleMessageListContainer .bubble-item')]
          .slice(${start}, ${start + size})
          .map((element) => ({
            mid: element.getAttribute('data-mid') || '',
            uuid: element.id || '',
            senderUid: element.querySelector('.comp-avator')?.getAttribute('uid') || '',
            actor: element.querySelector('.nickname')?.textContent?.trim() || element.querySelector('.nickname')?.innerText?.trim() || '',
            time: element.querySelector('.bubble-item-time')?.textContent?.trim() || element.querySelector('.bubble-item-time')?.innerText?.trim() || '',
            content: (() => {
              const message = [...element.querySelectorAll('.dx-message-text')].at(-1);
              const value = message?.textContent || message?.innerText || '';
              return { preview: value.slice(0, ${TEXT_PREVIEW_CHARS}), length: value.length };
            })(),
            refs: [...element.querySelectorAll('a[href]')].map((link) => link.href),
            raw: (() => {
              const value = element.textContent || element.innerText || '';
              return { preview: value.slice(0, ${TEXT_PREVIEW_CHARS}), length: value.length };
            })(),
          }));
        return btoa(unescape(encodeURIComponent(JSON.stringify(rows))));
      })()`);
      return {
        rows: hydrateRows(options, JSON.parse(decodeBase64(encoded)), start),
        requestedSize: size,
      };
    } catch (error) {
      if (size === 1) throw error;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  throw new Error(`Unable to extract browser rows at offset ${start}`);
}

function extractRange(options, start, count) {
  const rows = [];
  const end = start + count;
  for (let offset = start; offset < end;) {
    const chunk = extractChunk(options, offset, Math.min(10, end - offset));
    if (chunk.rows.length === 0) break;
    rows.push(...chunk.rows);
    offset += chunk.rows.length;
  }
  return rows;
}

function extractVisibleRows(options, state) {
  // The message list can be virtualized: the browser may report a large
  // loaded count while only the currently materialized rows remain in DOM.
  // Read the current DOM in small chunks (CatDesk truncates large evaluate
  // payloads) and merge it after every pagination step instead of assuming
  // all historical rows stay mounted.
  const expected = Math.max(0, Number(state.rows) || 0);
  return expected === 0 ? [] : extractRange(options, 0, expected);
}

function rowKey(row) {
  if (row.mid) return `mid:${row.mid}`;
  if (row.uuid) return `uuid:${row.uuid}`;
  return `fallback:${row.time}\u0000${row.actor}\u0000${row.content}\u0000${row.raw}`;
}

function mergeVisibleRows(target, rows, maxRecords) {
  let added = 0;
  for (const row of rows) {
    const key = rowKey(row);
    if (target.has(key)) continue;
    if (maxRecords && target.size >= maxRecords) break;
    target.set(key, row);
    added += 1;
  }
  return added;
}

function visibleSignature(state, rows) {
  const first = state.firstMid ? `mid:${state.firstMid}` : (rows[0] ? rowKey(rows[0]) : "");
  const last = state.lastMid ? `mid:${state.lastMid}` : (rows.at(-1) ? rowKey(rows.at(-1)) : "");
  return `${state.rows}|${state.hasLoadMore ? "more" : "end"}|${first}|${last}`;
}

function collectRows(options, state, previousDomRows, previousSignature) {
  const currentDomRows = Math.max(0, Number(state.rows) || 0);
  const signature = visibleSignature(state, []);
  const previous = Math.max(0, Number(previousDomRows) || 0);
  if (currentDomRows === 0) {
    // Route transitions can briefly unmount the message list. Preserve the
    // previous page count so recovery reads only the delta instead of
    // treating the next render as a brand-new full history.
    return { rows: [], domRows: previous, signature, complete: previous === 0 };
  }
  if (previous === 0 || currentDomRows < previous) {
    const rows = extractVisibleRows(options, state);
    return { rows, domRows: rows.length >= currentDomRows ? currentDomRows : previous, signature, complete: rows.length >= currentDomRows };
  }
  if (currentDomRows > previous) {
    // “加载更多” prepends older messages. Only read the newly materialized
    // prefix; re-reading the entire history made long groups unnecessarily
    // quadratic while preserving the same evidence semantics.
    const expected = currentDomRows - previous;
    const rows = extractRange(options, 0, expected);
    return { rows, domRows: rows.length >= expected ? currentDomRows : previous, signature, complete: rows.length >= expected };
  }
  if (signature !== previousSignature) {
    // Virtualized lists may keep a fixed DOM count while replacing its window.
    const rows = extractVisibleRows(options, state);
    return { rows, domRows: rows.length >= currentDomRows ? currentDomRows : previous, signature, complete: rows.length >= currentDomRows };
  }
  return { rows: [], domRows: previous, signature, complete: true };
}

function parseTimestamp(value) {
  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}T${match[4].padStart(2, "0")}:${match[5]}:00+08:00`;
  match = text.match(/^(\d{1,2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (match) return `${CAPTURE_DATE.slice(0, 4)}-${match[1].padStart(2, "0")}-${match[2]}T${match[3].padStart(2, "0")}:${match[4]}:00+08:00`;
  match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) return `${CAPTURE_DATE}T${match[1].padStart(2, "0")}:${match[2]}:00+08:00`;
  return null;
}

function normalizeRows(name, gid, rows, capture) {
  const participants = [...new Set(rows.map((row) => row.actor).filter(Boolean))];
  return rows.map((row, index) => {
    const id = row.mid || `dom-${gid}-${index}`;
    const refs = [`daxiang:gid:${gid}`, `messageId:${id}`, `mid:${id}`];
    if (row.uuid) refs.push(`uuid:${row.uuid}`);
    refs.push(`browser:https://x.sankuai.com/chat/${gid}?type=groupchat`);
    for (const ref of row.refs ?? []) if (ref && !refs.includes(ref)) refs.push(ref);
    return {
      conversation_id: `gid:${gid}`,
      id,
      role: "human",
      actor: row.actor || "未知发送者",
      senderUid: row.senderUid || null,
      timestamp: parseTimestamp(row.time),
      content: row.content?.trim() || "[非文本消息]",
      refs,
      participants,
      raw_text: row.raw || row.content || "",
      capture: {
        source: "elephant-browser-dom",
        readOnly: true,
        operation: "history-visible-dom",
        group_name: name,
        group_id: gid,
        captured_at: new Date().toISOString(),
        dom_time: row.time || null,
        completion: capture,
      },
    };
  });
}

function writeNewFile(output, records) {
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing evidence: ${output}`);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, output);
  chmodSync(output, 0o600);
}

function capture(options) {
  if (!options.current) {
    action(options, { action: "navigate", url: `https://x.sankuai.com/chat/${options.gid}?type=groupchat`, waitUntil: "domcontentloaded" });
    wait(options, options.waitMs);
  }
  let state = pageState(options);
  if (options.current && !state.href.includes(`/chat/${options.gid}?type=groupchat`)) {
    throw new Error(`--current requires the existing tab to be group ${options.gid}; found ${state.href}`);
  }
  let visibleRows = [];
  for (let attempt = 0; state.rows === 0 || visibleRows.length === 0 || visibleRows.length < state.rows; attempt += 1) {
    if (attempt >= 12) break;
    wait(options, Math.max(500, Math.floor(options.waitMs / 2)));
    state = pageState(options);
    if (state.rows > 0) visibleRows = extractVisibleRows(options, state);
  }
  if (state.rows === 0 || visibleRows.length === 0) throw new Error(`No visible messages at ${state.href}`);
  debug(options, "initial", { rows: state.rows, visible: visibleRows.length, hasLoadMore: state.hasLoadMore, text: state.loadMoreText });

  // Let the initial route settle before the first pagination click.  The
  // control can be present one render before its history handler is ready.
  let initialStable = 0;
  const routeStartSignature = visibleSignature(state, visibleRows);
  let initialSignature = routeStartSignature;
  for (let attempt = 0; attempt < 8 && initialStable < 3; attempt += 1) {
    wait(options, Math.max(1_000, options.waitMs));
    const nextState = pageState(options);
    const nextSignature = visibleSignature(nextState, []);
    state = nextState;
    if (nextSignature === initialSignature && !/加载中|loading/i.test(nextState.loadMoreText)) initialStable += 1;
    else {
      initialStable = 0;
      initialSignature = nextSignature;
    }
  }
  if (visibleSignature(state, []) !== routeStartSignature) visibleRows = extractVisibleRows(options, state);

  const rowsByKey = new Map();
  mergeVisibleRows(rowsByKey, visibleRows, options.maxRecords);
  let loadedDomRows = state.rows;
  let lastStateSignature = visibleSignature(state, visibleRows);
  let stalled = 0;
  let completion = { complete: false, stopReason: "unknown" };
  while (true) {
    const current = collectRows(options, state, loadedDomRows, lastStateSignature);
    visibleRows = current.rows;
    loadedDomRows = current.domRows;
    lastStateSignature = current.complete ? current.signature : null;
    mergeVisibleRows(rowsByKey, visibleRows, options.maxRecords);
    debug(options, "page", { rows: state.rows, visible: visibleRows.length, collected: rowsByKey.size, hasLoadMore: state.hasLoadMore, text: state.loadMoreText });
    if (options.maxRecords && rowsByKey.size >= options.maxRecords) {
      completion = { complete: false, stopReason: "max-records", collectedRows: rowsByKey.size };
      break;
    }
    if (!state.hasLoadMore) {
      // The UI can briefly render “没有更多数据了” before the final response
      // has been mounted. Require stable polls before declaring completion.
      let stable = 0;
      let lastSignature = lastStateSignature;
      for (let attempt = 0; attempt < 12 && stable < 5; attempt += 1) {
        wait(options, Math.max(1_000, options.waitMs));
        const nextState = pageState(options);
        const previousSignature = lastStateSignature;
        const next = collectRows(options, nextState, loadedDomRows, lastStateSignature);
        const added = mergeVisibleRows(rowsByKey, next.rows, options.maxRecords);
        state = nextState;
        visibleRows = next.rows;
        loadedDomRows = next.domRows;
        lastStateSignature = next.complete ? next.signature : null;
        debug(options, "no-more-poll", { attempt, rows: state.rows, visible: visibleRows.length, added, collected: rowsByKey.size, hasLoadMore: state.hasLoadMore, complete: next.complete });
        if (options.maxRecords && rowsByKey.size >= options.maxRecords) {
          completion = { complete: false, stopReason: "max-records", collectedRows: rowsByKey.size };
          break;
        }
        if (state.hasLoadMore) break;
        if (!next.complete) {
          stable = 0;
          continue;
        }
        if (next.signature === previousSignature) stable += 1;
        else {
          stable = 0;
          lastSignature = next.signature;
        }
      }
      if (completion.stopReason === "max-records") break;
      if (state.hasLoadMore) continue;
      if (rowsByKey.size < loadedDomRows) {
        completion = { complete: false, stopReason: "dom-extraction-gap", collectedRows: rowsByKey.size, expectedDomRows: loadedDomRows };
      } else {
        completion = { complete: true, stopReason: "no-more-messages", collectedRows: rowsByKey.size };
      }
      break;
    }
    if (/加载中|loading/i.test(state.loadMoreText)) {
      wait(options, Math.max(1_000, options.waitMs));
      state = pageState(options);
      continue;
    }
    const beforeCount = rowsByKey.size;
    const beforeSignature = lastStateSignature;
    if (!clickLoadMore(options)) {
      completion = { complete: false, stopReason: "load-more-control-disappeared", collectedRows: rowsByKey.size };
      break;
    }
    debug(options, "clicked-load-more", { collected: rowsByKey.size, beforeRows: state.rows });
    let progressed = false;
    let stable = 0;
    let lastSignature = beforeSignature;
    const maxProgressPolls = Math.max(24, options.stallRetries * 12);
    for (let attempt = 0; attempt < maxProgressPolls; attempt += 1) {
      wait(options, Math.max(1_000, options.waitMs));
      const nextState = pageState(options);
      const next = collectRows(options, nextState, loadedDomRows, lastStateSignature);
      const added = mergeVisibleRows(rowsByKey, next.rows, options.maxRecords);
      const nextSignature = next.signature;
      state = nextState;
      visibleRows = next.rows;
      loadedDomRows = next.domRows;
      lastStateSignature = next.complete ? next.signature : null;
      debug(options, "poll", { attempt, rows: state.rows, visible: visibleRows.length, added, collected: rowsByKey.size, hasLoadMore: state.hasLoadMore, text: state.loadMoreText, complete: next.complete });
      if (!next.complete) {
        stable = 0;
        continue;
      }
      if (added > 0 || nextSignature !== lastSignature) {
        progressed = true;
        stable = 0;
        lastSignature = nextSignature;
      } else {
        stable += 1;
      }
      if (options.maxRecords && rowsByKey.size >= options.maxRecords) break;
      if (stable >= 4 && !/加载中|loading/i.test(nextState.loadMoreText)) break;
    }
    if (rowsByKey.size > beforeCount) progressed = true;
    if (options.maxRecords && rowsByKey.size >= options.maxRecords) {
      completion = { complete: false, stopReason: "max-records", collectedRows: rowsByKey.size };
      break;
    }
    if (!progressed) stalled += 1;
    else stalled = 0;
    if (stalled >= options.stallRetries) {
      completion = { complete: false, stopReason: "stalled", collectedRows: rowsByKey.size };
      break;
    }
  }

  const rows = [...rowsByKey.values()];
  if (rows.length === 0) throw new Error("No rows extracted from the message pane");
  const records = normalizeRows(options.name, options.gid, rows, completion);
  writeNewFile(options.output, records);
  return {
    group: options.name,
    gid: options.gid,
    rows: records.length,
    complete: completion.complete,
    stopReason: completion.stopReason,
    output: options.output,
  };
}

try {
  console.log(JSON.stringify(capture(parseArgs(process.argv.slice(2))), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
