#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { DEFAULT_CARDS_ROOT, DEFAULT_MAX_RETRIEVALS, DEFAULT_RETRIEVAL_TTL_MS, SearchInputSchema, GetInputSchema, SearchOutputSchema, GetOutputSchema, parseCardMarkdown, scanCards, rankCards, createIkbCardsCore, searchCards, getCard } from "./ikb-cards-core.mjs";
export { DEFAULT_CARDS_ROOT, DEFAULT_MAX_RETRIEVALS, DEFAULT_RETRIEVAL_TTL_MS, SearchInputSchema, GetInputSchema, SearchOutputSchema, GetOutputSchema, parseCardMarkdown, scanCards, rankCards, createIkbCardsCore, searchCards, getCard };

function formatSearchMarkdown(result) {
  const lines = [
    "# IKB 卡片检索结果",
    "",
    `- retrieval_id: \`${result.retrievalId}\``,
    `- scope: \`${result.scope}\``,
    `- total: ${result.total}`,
    `- count: ${result.count}`,
    `- zero_result: ${result.zeroResult}`,
    "",
  ];
  for (const item of result.items) {
    lines.push(`## ${item.title}`);
    lines.push(`- card_id: \`${item.cardId}\``);
    lines.push(`- path: ${item.path}`);
    lines.push(`- matched_fields: ${item.matchedFields.join(", ")}`);
    lines.push("");
    lines.push(item.snippet);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatGetMarkdown(result) {
  return [
    "# 使用前先看：什么时候别信",
    "",
    result.card.whenNotTrust || "本卡未提供额外边界。",
    "",
    "---",
    "",
    result.card.markdown,
  ].join("\n");
}

function toolError(error) {
  const message = error instanceof Error ? error.message : "Unknown IKB Cards MCP error";
  return { isError: true, content: [{ type: "text", text: `IKB Cards MCP error: ${message}` }] };
}

export function createIkbCardsMcpServer(options = {}) {
  const core = options.core ?? createIkbCardsCore(options);
  const server = new McpServer(
    { name: "ikb-cards-mcp-server", version: "1.0.0" },
    {
      instructions:
        "Search cards before reading them. A card can only be read with the retrieval_id that returned its card_id. This server is local and read-only.",
    },
  );
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    "ikb_search_cards",
    {
      title: "Search IKB cards",
      description:
        "Search local IKB Markdown cards. work searches work+common; personal searches personal+common. Results are paginated and bind returned card ids to a retrieval id.",
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations,
    },
    async (params) => {
      try {
        const result = await searchCards(core, params);
        return {
          content: [
            {
              type: "text",
              text: params.response_format === "json" ? JSON.stringify(result, null, 2) : formatSearchMarkdown(result),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "ikb_get_card",
    {
      title: "Read a retrieved IKB card",
      description:
        "Read one card returned by ikb_search_cards in this server process. Rejects unknown retrievals, unreturned card ids, paths, traversal, scope escape, and changed content.",
      inputSchema: GetInputSchema,
      outputSchema: GetOutputSchema,
      annotations,
    },
    async (params) => {
      try {
        const result = await getCard(core, params);
        return {
          content: [
            {
              type: "text",
              text: params.response_format === "json" ? JSON.stringify(result, null, 2) : formatGetMarkdown(result),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  console.error("IKB MCP entry retired. Use ikb search|get instead.");
  process.exitCode = 2;
}
