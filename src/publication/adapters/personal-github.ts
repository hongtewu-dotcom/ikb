import type {
  PublicationBundle,
  PublicationManifest,
  PublicationManifestEntry,
} from "../contracts.ts";

export interface PersonalGithubOutput {
  manifest: PublicationManifest;
  files: Array<{ path: string; content: string }>;
}

export function buildPersonalGithubOutput(bundle: PublicationBundle, bundleHash: string): PersonalGithubOutput {
  const entries: PublicationManifestEntry[] = bundle.entries.map((entry) => ({
    public_id: entry.public_id,
    title: entry.title,
    category: entry.category,
    tags: entry.tags,
    path: `${entry.public_id}.md`,
    content_hash: entry.content_hash,
  }));
  const manifest: PublicationManifest = {
    schema_version: "ikb-personal-publication-manifest.v1",
    channel: "personal-github",
    bundle_hash: bundleHash,
    entries,
  };
  return {
    manifest,
    files: bundle.entries.map((entry) => ({
      path: `${entry.public_id}.md`,
      content: renderMarkdown(entry),
    })),
  };
}

function renderMarkdown(entry: PublicationBundle["entries"][number]): string {
  const contract = [
    entry.use_when ? `- 何时使用：${entry.use_when}` : "",
    entry.use_inputs.length > 0 ? `- 输入：${entry.use_inputs.join("；")}` : "",
    entry.use_outputs.length > 0 ? `- 输出：${entry.use_outputs.join("；")}` : "",
    ...entry.use_steps.map((step, index) => `${index + 1}. ${step}`),
    ...entry.use_checks.map((check) => `- 检查：${check}`),
    ...entry.use_stop_conditions.map((condition) => `- 停止条件：${condition}`),
  ].filter(Boolean);
  return [
    "---",
    `public_id: ${entry.public_id}`,
    `type: ${JSON.stringify(entry.type)}`,
    `category: ${JSON.stringify(entry.category)}`,
    `product_type: ${JSON.stringify(entry.product_type)}`,
    `title: ${JSON.stringify(entry.title)}`,
    `tags: ${JSON.stringify(entry.tags)}`,
    `valid_from: ${entry.valid_from}`,
    `temporal_state: ${entry.temporal_state}`,
    `content_hash: ${entry.content_hash}`,
    "---",
    "",
    `# ${entry.title}`,
    "",
    entry.summary,
    "",
    "## 适用范围",
    "",
    entry.applicability,
    "",
    "## 边界",
    "",
    entry.boundary,
    ...(entry.questions_answered.length > 0 ? [
      "",
      "## 能回答的问题",
      "",
      ...entry.questions_answered.map((question) => `- ${question}`),
    ] : []),
    ...(contract.length > 0 ? ["", "## 使用契约", "", ...contract] : []),
    "",
    "## 知识正文",
    "",
    entry.content_markdown.trim(),
    "",
  ].join("\n");
}
