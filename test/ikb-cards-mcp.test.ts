import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { spawnSync } from "node:child_process";
import {
  createIkbCardsCore,
  createIkbCardsMcpServer,
  getCard,
  searchCards,
  type GetCardResult,
  type SearchCardsResult,
} from "../mcp/ikb-cards-mcp-server.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const serverEntry = join(projectRoot, "mcp", "ikb-cards-mcp-server.mjs");

function createFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "ikb-cards-mcp-"));
  for (const scope of ["work", "personal", "common", "archive"]) mkdirSync(join(root, scope), { recursive: true });
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function writeCard(
  root: string,
  relativePath: string,
  card: { id: string; title: string; aliases: string[]; tags: string[]; body: string; whenNotTrust?: string },
): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "---",
      `id: ${card.id}`,
      `title: ${card.title}`,
      `aliases: [${card.aliases.join(", ")}]`,
      "updated_at: 2026-09-01",
      `tags: [${card.tags.join(", ")}]`,
      `sources: [${path}]`,
      "---",
      "",
      "## 是什么／怎么做",
      "",
      card.body,
      "",
      "## 什么时候用",
      "",
      "遇到相关问题时使用。",
      "",
      "## 什么时候别信",
      "",
      card.whenNotTrust ?? "当前源码或官方来源发生变化时不要直接采信。",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function asSearchResult(value: unknown): SearchCardsResult {
  assert.ok(value && typeof value === "object");
  return value as SearchCardsResult;
}

function asGetResult(value: unknown): GetCardResult {
  assert.ok(value && typeof value === "object");
  return value as GetCardResult;
}

async function connectInMemory(rootDir: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createIkbCardsMcpServer({ rootDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ikb-cards-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

test("core search isolates scopes and always excludes README and archive", async (t) => {
  const root = createFixture(t);
  writeCard(root, "work/team/work.md", {
    id: "work-card",
    title: "边界词 工作卡",
    aliases: ["工作知识"],
    tags: ["边界词"],
    body: "仅限工作作用域。",
  });
  const personalPath = writeCard(root, "personal/preferences/personal.md", {
    id: "personal-card",
    title: "边界词 个人卡",
    aliases: ["个人知识"],
    tags: ["边界词"],
    body: "仅限个人作用域。",
  });
  writeCard(root, "common/common.md", {
    id: "common-card",
    title: "边界词 通用卡",
    aliases: ["通用知识"],
    tags: ["边界词"],
    body: "两个作用域都可使用。",
  });
  writeCard(root, "work/archive/hidden.md", {
    id: "archived-card",
    title: "边界词 归档卡",
    aliases: ["归档知识"],
    tags: ["边界词"],
    body: "不得召回。",
  });
  writeCard(root, "work/README.md", {
    id: "readme-card",
    title: "边界词 README",
    aliases: ["说明"],
    tags: ["边界词"],
    body: "不得召回。",
  });
  symlinkSync(personalPath, join(root, "work", "personal-link.md"));

  const core = createIkbCardsCore({ rootDir: root });
  const work = await searchCards(core, { query: "边界词", scope: "work", response_format: "json" });
  const personal = await searchCards(core, { query: "边界词", scope: "personal" });

  assert.deepEqual(
    new Set(work.items.map((item) => item.cardId)),
    new Set(["work-card", "common-card"]),
  );
  assert.deepEqual(
    new Set(personal.items.map((item) => item.cardId)),
    new Set(["personal-card", "common-card"]),
  );
  assert.equal(work.items.some((item) => item.cardId === "personal-card"), false);
  assert.equal(personal.items.some((item) => item.cardId === "work-card"), false);
});

test("title, aliases, tags, and body are searchable with aliases ranked as a first-class field", async (t) => {
  const root = createFixture(t);
  writeCard(root, "work/alias.md", {
    id: "alias-card",
    title: "联合业务入口",
    aliases: ["机票联订"],
    tags: ["入口"],
    body: "处理组合业务。",
  });
  writeCard(root, "work/body.md", {
    id: "body-card",
    title: "普通流程",
    aliases: ["组合流程"],
    tags: ["流程"],
    body: "机票联订出现时从这里排查，机票联订需要检查边界。",
  });
  writeCard(root, "work/title.md", {
    id: "title-card",
    title: "机票交易组服务全貌",
    aliases: ["交易服务"],
    tags: ["服务归属"],
    body: "列出团队负责的服务。",
  });
  writeCard(root, "work/tag.md", {
    id: "tag-card",
    title: "故障处理",
    aliases: ["排障"],
    tags: ["验价失败"],
    body: "沿调用链定位。",
  });

  const core = createIkbCardsCore({ rootDir: root });
  const aliases = await searchCards(core, { query: "机票联订", scope: "work" });
  assert.equal(aliases.items[0]?.cardId, "alias-card");
  assert.ok(aliases.items[0]?.matchedFields.includes("aliases"));
  assert.ok(aliases.items.find((item) => item.cardId === "body-card")?.matchedFields.includes("body"));

  const naturalChinese = await searchCards(core, { query: "机票交易组负责哪些服务", scope: "work" });
  assert.equal(naturalChinese.items[0]?.cardId, "title-card");
  assert.ok(naturalChinese.items[0]?.matchedFields.includes("title"));

  const tags = await searchCards(core, { query: "验价失败", scope: "work" });
  assert.equal(tags.items[0]?.cardId, "tag-card");
  assert.ok(tags.items[0]?.matchedFields.includes("tags"));
});

test("zero results and pagination metadata are deterministic", async (t) => {
  const root = createFixture(t);
  for (const [index, title] of ["甲", "乙", "丙"].entries()) {
    writeCard(root, `work/page-${index}.md`, {
      id: `page-${index}`,
      title: `${title} 分页主题`,
      aliases: [`分页${title}`],
      tags: ["分页主题"],
      body: "分页测试内容。",
    });
  }
  const core = createIkbCardsCore({ rootDir: root });
  const first = await searchCards(core, { query: "分页主题", scope: "work", limit: 1, offset: 0 });
  const second = await searchCards(core, { query: "分页主题", scope: "work", limit: 1, offset: 1 });
  const zero = await searchCards(core, { query: "一定不存在的词-7f34", scope: "work" });

  assert.deepEqual(
    { total: first.total, count: first.count, offset: first.offset, hasMore: first.hasMore, nextOffset: first.nextOffset },
    { total: 3, count: 1, offset: 0, hasMore: true, nextOffset: 1 },
  );
  assert.deepEqual(
    { total: second.total, count: second.count, offset: second.offset, hasMore: second.hasMore, nextOffset: second.nextOffset },
    { total: 3, count: 1, offset: 1, hasMore: true, nextOffset: 2 },
  );
  assert.equal(first.queryHash.length, 64);
  assert.deepEqual(
    { total: zero.total, count: zero.count, zeroResult: zero.zeroResult, hasMore: zero.hasMore, nextOffset: zero.nextOffset },
    { total: 0, count: 0, zeroResult: true, hasMore: false, nextOffset: null },
  );
});

test("get is bound to returned cards, rejects paths, and rejects changed content", async (t) => {
  const root = createFixture(t);
  const firstPath = writeCard(root, "work/first.md", {
    id: "first-card",
    title: "绑定主题 甲",
    aliases: ["绑定甲"],
    tags: ["绑定主题"],
    body: "第一张卡。",
    whenNotTrust: "来源变化后必须重新检索。",
  });
  writeCard(root, "work/second.md", {
    id: "second-card",
    title: "绑定主题 乙",
    aliases: ["绑定乙"],
    tags: ["绑定主题"],
    body: "第二张卡。",
  });

  const core = createIkbCardsCore({ rootDir: root });
  const search = await searchCards(core, { query: "绑定主题", scope: "work", limit: 1 });
  const returnedId = search.items[0]!.cardId;
  const notReturnedId = returnedId === "first-card" ? "second-card" : "first-card";
  const read = await getCard(core, { retrieval_id: search.retrievalId, card_id: returnedId });

  assert.equal(read.schema, "ikb-card-read-result-v1");
  assert.equal(read.card.cardId, returnedId);
  assert.match(read.card.whenNotTrust, /重新检索|不要直接采信/u);
  assert.equal(read.card.contentHash.length, 64);
  await assert.rejects(
    getCard(core, { retrieval_id: search.retrievalId, card_id: notReturnedId }),
    /not returned by the specified retrieval/u,
  );
  await assert.rejects(
    getCard(core, { retrieval_id: search.retrievalId, card_id: "../work/first.md" }),
    /paths and traversal/u,
  );
  await assert.rejects(
    getCard(core, { retrieval_id: "not-a-retrieval", card_id: returnedId }),
    /Unknown retrieval_id/u,
  );

  const returnedPath = search.items[0]!.path;
  writeFileSync(returnedPath, `${readFileSync(returnedPath, "utf8")}\nchanged\n`, "utf8");
  await assert.rejects(
    getCard(core, { retrieval_id: search.retrievalId, card_id: returnedId }),
    /content changed after retrieval/u,
  );
  assert.ok(firstPath.startsWith(root));
});

test("opaque ids stay readable while retrieval state is bounded and expires", async (t) => {
  const root = createFixture(t);
  writeCard(root, "work/opaque.md", {
    id: "opaque..id",
    title: "有界召回状态",
    aliases: ["召回过期"],
    tags: ["召回"],
    body: "验证 card id 与短期召回绑定。",
  });
  let now = 1_000;
  const core = createIkbCardsCore({ rootDir: root, maxRetrievals: 2, retrievalTtlMs: 100, now: () => now });

  const first = await searchCards(core, { query: "召回过期", scope: "work" });
  const readable = await getCard(core, { retrieval_id: first.retrievalId, card_id: "opaque..id" });
  assert.equal(readable.card.cardId, "opaque..id");

  const second = await searchCards(core, { query: "召回过期", scope: "work" });
  const third = await searchCards(core, { query: "召回过期", scope: "work" });
  assert.equal(core.retrievals.size, 2);
  await assert.rejects(
    getCard(core, { retrieval_id: first.retrievalId, card_id: "opaque..id" }),
    /Unknown retrieval_id/u,
  );

  now += 101;
  await assert.rejects(
    getCard(core, { retrieval_id: second.retrievalId, card_id: "opaque..id" }),
    /Unknown retrieval_id/u,
  );
  assert.equal(core.retrievals.has(third.retrievalId), false);
});

test("v2 client handshake, tools/list, and both tools/call work over in-memory transport without writes", async (t) => {
  const root = createFixture(t);
  const path = writeCard(root, "common/protocol.md", {
    id: "protocol-card",
    title: "协议握手卡",
    aliases: ["MCP握手"],
    tags: ["协议"],
    body: "用于验证两个工具。",
    whenNotTrust: "协议版本变化后重新核对官方 SDK。",
  });
  const before = readFileSync(path, "utf8");
  const connection = await connectInMemory(root);
  t.after(connection.close);

  const listed = await connection.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["ikb_get_card", "ikb_search_cards"],
  );
  for (const tool of listed.tools) {
    assert.deepEqual(
      {
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
        openWorldHint: tool.annotations?.openWorldHint,
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    );
  }

  const searched = await connection.client.callTool({
    name: "ikb_search_cards",
    arguments: { query: "MCP握手", scope: "work", response_format: "json" },
  });
  assert.equal(searched.isError, undefined);
  const searchResult = asSearchResult(searched.structuredContent);
  assert.equal(searchResult.schema, "ikb-card-search-result-v1");
  assert.equal(searchResult.items[0]?.cardId, "protocol-card");

  const read = await connection.client.callTool({
    name: "ikb_get_card",
    arguments: {
      retrieval_id: searchResult.retrievalId,
      card_id: "protocol-card",
      response_format: "markdown",
    },
  });
  assert.equal(read.isError, undefined);
  const readResult = asGetResult(read.structuredContent);
  assert.equal(readResult.schema, "ikb-card-read-result-v1");
  assert.match(readResult.card.markdown, /协议握手卡/u);
  assert.match(read.content[0]?.type === "text" ? read.content[0].text : "", /^# 使用前先看：什么时候别信/u);
  assert.equal(readFileSync(path, "utf8"), before);

  const traversal = await connection.client.callTool({
    name: "ikb_get_card",
    arguments: { retrieval_id: searchResult.retrievalId, card_id: "../../etc/passwd" },
  });
  assert.equal(traversal.isError, true);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("retired stdio entry exits instead of restarting a resident server", () => {
  const result = spawnSync(process.execPath, [serverEntry], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /IKB MCP entry retired/u);
});
