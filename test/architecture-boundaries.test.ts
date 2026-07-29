import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("person evidence projection does not depend on the Knowledge service", () => {
  const source = read("src/person.ts");
  assert.doesNotMatch(source, /from ["']\.\/knowledge\.ts["']/);
  assert.match(source, /from ["']\.\/layout\.ts["']/);
});

test("daily maintenance owns knowledge convergence, not historical Run repair", () => {
  const plan = read("scripts/ikb-maintenance-plan.mjs");
  assert.doesNotMatch(plan, /run-evaluation-repair/);
  assert.doesNotMatch(plan, /["']harness["'],\s*["']repair["']/);
  assert.match(plan, /candidate-resolve/);
  assert.match(plan, /knowledge-rebuild/);
});

test("filesystem layout is an explicit shared contract", () => {
  const layout = read("src/layout.ts");
  assert.match(layout, /export function resolveVault/);
  assert.match(layout, /IKB_WORK_VAULT/);
  assert.match(layout, /vaults/);
});

test("CLI is a routing facade and does not own domain behavior", () => {
  const cli = read("src/cli.ts");
  const imports = [...cli.matchAll(/from ["'](\.\/[^"']+)["']/g)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  assert.deepEqual(
    imports.filter((path) => !path.startsWith("./commands/") && path !== "./store.ts" && path !== "./format.ts"),
    [],
  );
  assert.doesNotMatch(cli, /function handle[A-Z]/);
  assert.match(cli, /handleSource/);
  assert.match(cli, /handleKnowledge/);
  assert.match(cli, /handleHarness/);
});

test("Knowledge facade has one-way dependencies into cohesive submodules", () => {
  const facade = read("src/knowledge.ts");
  assert.doesNotMatch(facade, /\bfunction\s+/);
  assert.match(facade, /knowledge\/repository\.ts/);
  assert.match(facade, /knowledge\/lifecycle\.ts/);

  const knowledgeRoot = join(root, "src", "knowledge");
  for (const entry of readdirSync(knowledgeRoot).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(knowledgeRoot, entry), "utf8");
    assert.doesNotMatch(source, /from ["']\.\.\/knowledge\.ts["']/, `${entry} must not depend on the public facade`);
  }
});

test("Publication facade has one-way dependencies into builder, workflow and adapters", () => {
  const facade = read("src/publication.ts");
  assert.doesNotMatch(facade, /\bfunction\s+/);
  assert.match(facade, /publication\/build\.ts/);
  assert.match(facade, /publication\/workflow\.ts/);
  assert.equal(existsSync(join(root, "src", "commands", "publication.ts")), true);

  const publicationRoot = join(root, "src", "publication");
  for (const entry of readdirSync(publicationRoot, { recursive: true }).filter((name) => String(name).endsWith(".ts"))) {
    const source = readFileSync(join(publicationRoot, String(entry)), "utf8");
    assert.doesNotMatch(source, /from ["']\.\.\/publication\.ts["']/, `${String(entry)} must not depend on the public facade`);
  }
});

test("Source, Candidate, and People command responsibilities stay physically separated", () => {
  for (const path of ["src/commands/source-intake.ts", "src/commands/candidate.ts", "src/commands/people.ts", "src/commands/source-shared.ts"]) {
    assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
  }
  assert.doesNotMatch(read("src/commands/source-intake.ts"), /function handle(?:Candidate|People)/);
  assert.doesNotMatch(read("src/commands/candidate.ts"), /function handle(?:Source|People)/);
  assert.doesNotMatch(read("src/commands/people.ts"), /function handle(?:Source|Candidate)/);
});
