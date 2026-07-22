import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addKeyPerson, keyPeoplePath, listKeyPeople, removeKeyPerson, updateKeyPerson } from "../src/people.ts";

test("key people are maintained in a private local registry", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-key-people-"));
  const first = addKeyPerson(home, "alice", { mis: "alice", scope: "work", aliases: ["Alice", "alice"] });
  const second = addKeyPerson(home, "bob", { mis: "bob", name: "示例用户", scope: "work" });
  assert.equal(first.enabled, true);
  assert.deepEqual(first.aliases, ["Alice", "alice"]);
  assert.equal(listKeyPeople(home, "work").map((person) => person.id).join(","), "alice,bob");
  assert.equal(lstatSync(keyPeoplePath(home)).mode & 0o777, 0o600);
  assert.match(readFileSync(keyPeoplePath(home), "utf8"), /alice/);
  const updated = updateKeyPerson(home, "bob", { uid: "uid-bob", name: "示例用户", aliases: ["B"] });
  assert.equal(updated.uid, "uid-bob");
  assert.deepEqual(updated.aliases, ["B"]);
  assert.equal(listKeyPeople(home).find((person) => person.id === "bob")?.name, "示例用户");
  assert.equal(removeKeyPerson(home, "alice").id, "alice");
  assert.deepEqual(listKeyPeople(home).map((person) => person.id), ["bob"]);
  assert.throws(() => removeKeyPerson(home, "missing"), /not found/);
  assert.throws(() => addKeyPerson(home, "bob", { mis: "bob" }), /already exists/);
  assert.throws(() => addKeyPerson(home, "other", { mis: "bob" }), /MIS already exists/);
  void second;
});
