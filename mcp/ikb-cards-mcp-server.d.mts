import type { McpServer } from "@modelcontextprotocol/server";
import type { IkbCardsCore } from "./ikb-cards-core.mjs";
export * from "./ikb-cards-core.mjs";

export function createIkbCardsMcpServer(options?: {
  rootDir?: string;
  maxRetrievals?: number;
  retrievalTtlMs?: number;
  now?: () => number;
  core?: IkbCardsCore;
}): McpServer;
