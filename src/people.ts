import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface KeyPerson {
  id: string;
  mis: string | null;
  uid: string | null;
  name: string | null;
  aliases: string[];
  scope: "personal" | "work";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KeyPersonInput {
  mis?: string;
  uid?: string;
  name?: string;
  aliases?: string[];
  scope?: string;
}

interface KeyPeopleFile {
  version: 1;
  people: KeyPerson[];
}

export function keyPeoplePath(home: string): string {
  return join(resolve(home), "entities", "people", "key-people.json");
}

export function initializeKeyPeople(home: string): string {
  const path = keyPeoplePath(home);
  ensurePrivateDirectory(dirname(path));
  if (!existsSync(path)) writePeopleFile(path, { version: 1, people: [] });
  else ensurePrivateFile(path);
  return path;
}

export function listKeyPeople(home: string, scope?: string): KeyPerson[] {
  const file = readPeopleFile(initializeKeyPeople(home));
  const normalizedScope = normalizeScope(scope);
  return file.people
    .filter((person) => !normalizedScope || person.scope === normalizedScope)
    .map((person) => ({ ...person, aliases: [...person.aliases] }));
}

export function findKeyPerson(home: string, idValue: string, scope?: string): KeyPerson | null {
  const lookup = String(idValue ?? "").trim().toLocaleLowerCase();
  if (!lookup) return null;
  return listKeyPeople(home, scope).find((person) => [person.id, person.mis].filter(Boolean).some((value) => value!.toLocaleLowerCase() === lookup)) ?? null;
}

export function addKeyPerson(home: string, idValue: string, input: KeyPersonInput = {}): KeyPerson {
  const path = initializeKeyPeople(home);
  const file = readPeopleFile(path);
  const id = normalizeId(idValue);
  if (file.people.some((person) => person.id === id)) throw new Error(`Key person already exists: ${id}`);
  const mis = normalizeOptional(input.mis);
  if (mis && file.people.some((person) => person.mis === mis)) throw new Error(`Key person MIS already exists: ${mis}`);
  const uid = normalizeOptional(input.uid);
  if (uid && file.people.some((person) => person.uid === uid)) throw new Error(`Key person UID already exists: ${uid}`);
  const timestamp = new Date().toISOString();
  const person: KeyPerson = {
    id,
    mis,
    uid,
    name: normalizeOptional(input.name),
    aliases: normalizeAliases(input.aliases),
    scope: normalizeScope(input.scope) ?? "work",
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  file.people.push(person);
  file.people.sort((left, right) => left.id.localeCompare(right.id));
  writePeopleFile(path, file);
  return person;
}

export function updateKeyPerson(home: string, idValue: string, input: KeyPersonInput = {}): KeyPerson {
  const path = initializeKeyPeople(home);
  const file = readPeopleFile(path);
  const lookup = String(idValue ?? "").trim().toLocaleLowerCase();
  const index = file.people.findIndex((person) => person.id.toLocaleLowerCase() === lookup || person.mis?.toLocaleLowerCase() === lookup);
  if (index < 0) throw new Error(`Key person not found: ${idValue}`);
  const current = file.people[index];
  const mis = input.mis === undefined ? current.mis : normalizeOptional(input.mis);
  const uid = input.uid === undefined ? current.uid : normalizeOptional(input.uid);
  if (mis && file.people.some((person, personIndex) => personIndex !== index && person.mis === mis)) throw new Error(`Key person MIS already exists: ${mis}`);
  if (uid && file.people.some((person, personIndex) => personIndex !== index && person.uid === uid)) throw new Error(`Key person UID already exists: ${uid}`);
  const updated: KeyPerson = {
    ...current,
    mis,
    uid,
    name: input.name === undefined ? current.name : normalizeOptional(input.name),
    aliases: input.aliases === undefined ? [...current.aliases] : normalizeAliases(input.aliases),
    scope: input.scope === undefined ? current.scope : (normalizeScope(input.scope) ?? current.scope),
    updatedAt: new Date().toISOString(),
  };
  file.people[index] = updated;
  file.people.sort((left, right) => left.id.localeCompare(right.id));
  writePeopleFile(path, file);
  return updated;
}

export function removeKeyPerson(home: string, idValue: string): KeyPerson {
  const path = initializeKeyPeople(home);
  const file = readPeopleFile(path);
  const id = normalizeId(idValue);
  const index = file.people.findIndex((person) => person.id === id || person.mis === id);
  if (index < 0) throw new Error(`Key person not found: ${id}`);
  const [removed] = file.people.splice(index, 1);
  writePeopleFile(path, file);
  return removed;
}

function readPeopleFile(path: string): KeyPeopleFile {
  ensurePrivateFile(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid key people file ${path}: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid key people file ${path}`);
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.people)) throw new Error(`Invalid key people file ${path}: expected version 1 and people[]`);
  return { version: 1, people: record.people.map(normalizePerson) };
}

function normalizePerson(value: unknown): KeyPerson {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid key person entry");
  const record = value as Record<string, unknown>;
  const id = normalizeId(String(record.id ?? ""));
  const scope = normalizeScope(String(record.scope ?? "work"));
  if (!scope) throw new Error(`Key person ${id} has no scope`);
  return {
    id,
    mis: normalizeOptional(record.mis),
    uid: normalizeOptional(record.uid),
    name: normalizeOptional(record.name),
    aliases: normalizeAliases(Array.isArray(record.aliases) ? record.aliases.map(String) : []),
    scope,
    enabled: record.enabled !== false,
    createdAt: String(record.createdAt ?? ""),
    updatedAt: String(record.updatedAt ?? ""),
  };
}

function writePeopleFile(path: string, file: KeyPeopleFile): void {
  ensurePrivateDirectory(dirname(path));
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Key people directory must be a real directory: ${path}`);
  chmodSync(path, 0o700);
}

function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Key people file not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Key people file must be a real file: ${path}`);
  chmodSync(path, 0o600);
}

function normalizeId(value: string): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`Key person id must use letters, numbers, dot, underscore or hyphen: ${id}`);
  return id;
}

function normalizeOptional(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeAliases(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeScope(scope: string | undefined): "personal" | "work" | undefined {
  if (scope === undefined || scope === "") return undefined;
  if (scope !== "personal" && scope !== "work") throw new Error(`Key person scope must be personal or work: ${scope}`);
  return scope;
}
