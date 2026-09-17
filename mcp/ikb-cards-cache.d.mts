import type { RetrievalStore } from "./ikb-cards-core.mjs";
export function createDiskRetrievalStore(options?: { directory?: string }): RetrievalStore & { directory: string };
