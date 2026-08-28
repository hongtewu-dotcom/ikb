import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = resolve(import.meta.dirname, "..");
const cli = join(repository, "src", "cli.ts");

function runCli(home: string, args: string[]): unknown {
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    cli,
    ...args,
    "--home",
    home,
    "--json",
  ], { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("CLI externalizes history raw with a ledgered migration and keeps doctor green", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-history-external-cli-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "rollout.jsonl");
  mkdirSync(home, { recursive: true });
  writeFileSync(input, `${JSON.stringify({ session_id: "session", turn_id: "1", role: "user", content: "evidence" })}\n`);

  runCli(home, ["init"]);
  const imported = runCli(home, ["source", "ingest", input, "--kind", "ai_conversation", "--adapter", "codex", "--scope", "work", "--no-incremental"]) as {
    source: { id: string; rawPath: string };
  };
  const managedRawPath = imported.source.rawPath;
  assert.equal(existsSync(managedRawPath), true);

  const migration = runCli(home, ["source", "externalize-history-raw", "--scope", "work"]) as {
    migratedSources: number;
    removedBytes: number;
    issues: unknown[];
  };
  assert.equal(migration.migratedSources, 1);
  assert.equal(migration.removedBytes > 0, true);
  assert.deepEqual(migration.issues, []);
  assert.equal(existsSync(managedRawPath), false);

  const doctor = runCli(home, ["doctor"]) as { ok: boolean };
  assert.equal(doctor.ok, true);
  const context = runCli(home, ["source", "context", imported.source.id]) as { markdown: string };
  assert.match(context.markdown, /evidence/);
});
