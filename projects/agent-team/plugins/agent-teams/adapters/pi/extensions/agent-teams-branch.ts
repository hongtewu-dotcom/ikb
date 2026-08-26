/** Pi extension runner for bounded agent-teams branches.
 *
 * Delegation is explicitly process-mediated:
 * `pi --mode json -p --no-session --no-extensions`.
 */
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const receiptKeys = ["status", "summary", "evidence", "changes", "validation", "gaps"];
const branchKeys = ["goal", "scope", "acceptance", "handoff"];
const writerKeys = ["write_scope", "forbidden_scope", "depends_on", "produces"];

export function validateBranchContract(value: unknown, writer = false): boolean {
  if (!value || typeof value !== "object") return false;
  const contract = value as Record<string, unknown>;
  const required = writer ? [...branchKeys, ...writerKeys] : branchKeys;
  return required.every((key) => contract[key] !== undefined && String(contract[key]).trim());
}

export function validateReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return receiptKeys.every((key) => key in receipt)
    && ["completed", "partial", "blocked"].includes(String(receipt.status));
}

function finalAssistantText(stdout: string): string {
  let finalText: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type !== "message_end" || !event.message || typeof event.message !== "object") continue;
    const message = event.message as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => (
        !!block && typeof block === "object"
          && (block as Record<string, unknown>).type === "text"
          && typeof (block as Record<string, unknown>).text === "string"
      ))
      .map((block) => block.text)
      .join("");
    if (text.trim()) finalText = text;
  }
  if (finalText === undefined) throw new Error("isolated Pi returned no final assistant message");
  return finalText;
}

export async function agent_teams_branch(
  prompt: string,
  options: { signal?: AbortSignal; writer?: boolean } = {},
): Promise<unknown> {
  if (!prompt.trim()) throw new Error("branch prompt must carry a validated branch contract");
  const tools = options.writer ? "read,write,edit,bash" : "read,grep,find,ls";
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["--mode", "json", "-p", "--no-session", "--no-extensions", "--tools", tools],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PI_DISABLE_EXTENSIONS: "1" },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`isolated Pi exited ${code}: ${stderr}`));
      try {
        const receipt = JSON.parse(finalAssistantText(stdout));
        if (!validateReceipt(receipt)) return reject(new Error("invalid branch receipt"));
        resolve(receipt);
      } catch (error) { reject(error); }
    });
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.stdin.end(prompt);
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_teams_branch",
    label: "Agent Teams Branch",
    description: "Run a bounded branch in an isolated Pi process and return its validated six-field receipt.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Branch prompt carrying goal, scope, acceptance, and handoff." }),
      writer: Type.Optional(Type.Boolean({ description: "Whether the prompt carries the extended writer contract." })),
    }),
    async execute(_toolCallId, params, signal) {
      const receipt = await agent_teams_branch(params.prompt, { signal, writer: params.writer });
      return {
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        details: { receipt },
      };
    },
  });
}
