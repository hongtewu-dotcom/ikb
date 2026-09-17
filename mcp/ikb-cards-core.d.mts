export type CardScope = "work" | "personal";
export type ResponseFormat = "markdown" | "json";
export type RetrievalPolicy = "legacy" | "entries";
export interface RetrievalEntry { objects: string[]; intents: string[] }
export interface MatchedEntry extends RetrievalEntry { index: number }

export interface SearchCardsInput {
  query: string;
  scope: CardScope;
  limit?: number;
  offset?: number;
  response_format?: ResponseFormat;
}

export interface GetCardInput {
  retrieval_id: string;
  card_id: string;
  response_format?: ResponseFormat;
}

export interface SearchCardItem {
  cardId: string;
  title: string;
  path: string;
  contentHash: string;
  matchedFields: Array<"title" | "aliases" | "tags" | "body">;
  snippet: string;
  matchedEntries?: MatchedEntry[];
}

export interface SearchCardsResult {
  schema: "ikb-card-search-result-v1";
  retrievalId: string;
  scope: CardScope;
  queryHash: string;
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  zeroResult: boolean;
  items: SearchCardItem[];
}

export interface GetCardResult {
  schema: "ikb-card-read-result-v1";
  retrievalId: string;
  scope: CardScope;
  card: {
    cardId: string;
    title: string;
    path: string;
    contentHash: string;
    whenNotTrust: string;
    markdown: string;
  };
}

export interface ParsedCard {
  cardId: string;
  title: string;
  aliases: string[];
  tags: string[];
  body: string;
  whenNotTrust: string;
  retrieval?: RetrievalEntry[];
}

export interface ScannedCard extends ParsedCard {
  path: string;
  markdown: string;
  contentHash: string;
}

export interface RetrievalBinding {
  scope: CardScope;
  createdAt: number;
  cards: Map<string, { path: string; contentHash: string }>;
}

export interface RetrievalStore {
  save(id: string, retrieval: RetrievalBinding, core: IkbCardsCore): Promise<void>;
  load(id: string, core: IkbCardsCore): Promise<RetrievalBinding | null>;
}

export interface IkbCardsCore {
  retrievalPolicy: RetrievalPolicy;
  retrievalStore?: RetrievalStore;
  rootDir: string;
  maxRetrievals: number;
  retrievalTtlMs: number;
  now: () => number;
  retrievals: Map<
    string,
    {
      scope: CardScope;
      createdAt: number;
      cards: Map<string, { path: string; contentHash: string }>;
    }
  >;
}

export const DEFAULT_CARDS_ROOT: string;
export const DEFAULT_MAX_RETRIEVALS: number;
export const DEFAULT_RETRIEVAL_TTL_MS: number;
export const DEFAULT_CLI_RETRIEVAL_POLICY: RetrievalPolicy;
export function isActiveCardEntry(entry: { name: string; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): boolean;
export const SearchInputSchema: unknown;
export const GetInputSchema: unknown;
export const SearchOutputSchema: unknown;
export const GetOutputSchema: unknown;

export function parseCardMarkdown(markdown: string, filePath: string, options?: { retrievalPolicy?: RetrievalPolicy }): ParsedCard;
export function scanCards(core: IkbCardsCore, scope: CardScope): Promise<ScannedCard[]>;
export function rankCards(
  cards: ScannedCard[],
  query: string,
  options?: { retrievalPolicy?: RetrievalPolicy },
): Array<{ card: ScannedCard; score: number; matchedFields: SearchCardItem["matchedFields"]; snippet: string; matchedEntries?: MatchedEntry[] }>;
export function createIkbCardsCore(options?: {
  retrievalPolicy?: RetrievalPolicy;
  retrievalStore?: RetrievalStore;
  rootDir?: string;
  maxRetrievals?: number;
  retrievalTtlMs?: number;
  now?: () => number;
}): IkbCardsCore;
export function searchCards(core: IkbCardsCore, input: SearchCardsInput): Promise<SearchCardsResult>;
export function getCard(core: IkbCardsCore, input: GetCardInput): Promise<GetCardResult>;
