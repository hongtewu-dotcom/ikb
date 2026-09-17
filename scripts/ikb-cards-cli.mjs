#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createIkbCardsCore, searchCards, getCard, DEFAULT_CLI_RETRIEVAL_POLICY } from "../mcp/ikb-cards-core.mjs";
import { createDiskRetrievalStore } from "../mcp/ikb-cards-cache.mjs";
import { listRequests, requestStatus, submitRequest, recordRequestDecision } from "./ikb-requests.mjs";

async function main() {
try {
  const { values, positionals } = parseArgs({ options: {
    scope: { type: "string" }, query: { type: "string" }, limit: { type: "string" }, offset: { type: "string" },
    "retrieval-id": { type: "string" }, "card-id": { type: "string" }, help: { type: "boolean" },
    input: { type: "string" }, "intake-root": { type: "string" }, "cards-root": { type: "string" },
    pending: { type: "boolean" },
  }, allowPositionals: true, strict: true });
  if (values.help) {
    console.log(`ikb search --scope work|personal --query TEXT [--limit 8] [--offset 0]\nikb get --retrieval-id ID --card-id ID\nikb feedback --input FILE [--intake-root DIR] [--cards-root DIR]\nikb request-update --input FILE [--intake-root DIR] [--cards-root DIR]\nikb request status ID [--intake-root DIR]\nikb request decision ID --input FILE [--intake-root DIR]\nikb request list --pending [--intake-root DIR]\nRequest input JSON: {"scope":"work","question":"...","source":{"host":"...","sessionId":"...","messageId":"...","reference":"..."},"targetCardId":"...","change":"...","candidatePath":"...","evidenceRefs":["..."],"acceptance":{"positiveQueries":["..."],"negativeQueries":["..."]}}; targetCardId/change/candidatePath/evidenceRefs/acceptance are optional, but request-update requires change. Update acceptance defaults positiveQueries to question; explicit positives must retain question. Add #line=N to a source or evidence reference for a bounded line snapshot.\nUpdate returns execution metadata for the current host to call native subagents directly; no process or model is launched.\nReturns JSON. Search bindings expire after 30 minutes; commands exit after each call.\nIKB_RETRIEVAL_POLICY=legacy|entries (default ${DEFAULT_CLI_RETRIEVAL_POLICY}). entries requires retrieval objects/intents on every work/common card. IKB_CARDS_ROOT and IKB_RETRIEVAL_CACHE_DIR select isolated data/cache roots.`);
  } else {
    if (!positionals.length || !["search", "get", "feedback", "request-update", "request"].includes(positionals[0])) throw new Error("Expected ikb search, get, feedback, request-update or request (see --help)");
    const command = positionals[0];
    if (command === "request") {
      const subcommand = positionals[1];
      if (subcommand === "decision") {
        if (positionals.length !== 3 || !values.input || Object.keys(values).some(key => !["input", "intake-root"].includes(key))) throw new Error("Expected ikb request decision ID --input FILE [--intake-root DIR]");
        console.log(JSON.stringify(recordRequestDecision(positionals[2], JSON.parse(readFileSync(values.input, "utf8")), { intakeRoot: values["intake-root"] })));
      } else if (subcommand === "status") {
        if (positionals.length !== 3 || Object.keys(values).some((key) => !["intake-root"].includes(key))) throw new Error("Expected ikb request status ID [--intake-root DIR]");
        console.log(JSON.stringify(requestStatus(positionals[2], { intakeRoot: values["intake-root"] })));
      } else if (subcommand === "list") {
        if (positionals.length !== 2 || Object.keys(values).some((key) => !["intake-root", "pending"].includes(key))) throw new Error("Expected ikb request list --pending [--intake-root DIR]");
        console.log(JSON.stringify({ schema: "ikb-request-list-v1", pending: values.pending === true, items: listRequests({ intakeRoot: values["intake-root"], pending: values.pending === true }) }));
      } else throw new Error("Expected ikb request status ID or request list --pending (see --help)");
      return;
    }
    const allowed = command === "search" ? ["scope", "query", "limit", "offset"] : command === "get" ? ["retrieval-id", "card-id"] : ["input", "intake-root", "cards-root"];
    for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unexpected --${key} for ${command}`);
    if (command === "feedback" || command === "request-update") {
      if (positionals.length !== 1 || typeof values.input !== "string") throw new Error(`Expected ikb ${command} --input FILE`);
      const input = JSON.parse(readFileSync(values.input, "utf8"));
      const result = submitRequest(input, { kind: command === "feedback" ? "feedback" : "update", intakeRoot: values["intake-root"], cardsRoot: values["cards-root"] });
      console.log(JSON.stringify(result));
      return;
    }
    if (positionals.length !== 1) throw new Error(`Expected ikb ${command} (see --help)`);
    const core = createIkbCardsCore({ retrievalStore: createDiskRetrievalStore(), retrievalPolicy: process.env.IKB_RETRIEVAL_POLICY ?? DEFAULT_CLI_RETRIEVAL_POLICY });
    const result = command === "search"
      ? await searchCards(core, { scope: values.scope, query: values.query, ...(values.limit === undefined ? {} : { limit: Number(values.limit) }), ...(values.offset === undefined ? {} : { offset: Number(values.offset) }) })
      : await getCard(core, { retrieval_id: values["retrieval-id"], card_id: values["card-id"] });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
}
main();
