// manifest.ts — the lock, in one canonical form.
//
// Verify compares the lock byte for byte, so "the lock is up to date" has to be
// a decidable question rather than a question about JSON formatting. One
// rendering, stated here, is what makes it decidable.
//
// The file holds what the tool resolved and nothing else. Every metadata field
// it used to carry — the tool's own version, the repository it came from, the
// source path of each contract — was a value no check consumed, and the tool's
// version in particular put a byte nobody verified into the comparison:
// releasing a new version of the tool made every consuming repository's verify
// fail until the tree was regenerated.
//
// The file is `vendor-lock.json`. It was `vendor-manifest.json` while the lock
// was the only file the tool read, and the name had to move once the tool
// gained a declaration file: `vendor-manifest.yaml` is what a reader now means
// by "the manifest", and two files a letter apart in spelling and opposite in
// authorship — one written by hand, one written only by the tool — is the
// confusion the rename removes.

import * as fs from "node:fs/promises";
import { ConfigError, describeCause } from "./errors.ts";
import { assertValidContractId, compareStrings } from "./digest.ts";
import { assertPlainContractPaths } from "./conformance.ts";
import type { ContractLocation } from "./sources.ts";
import { emptyRecord } from "./records.ts";
import { assertPlainChain, decodeUtf8, isRegularFileOrAbsent } from "./walk.ts";
import {
  dependenciesOf,
  type Dependencies,
  type SkillDeclaration,
} from "./declaration.ts";

/** The one file the lock lives in. */
export const LOCK_FILE = "vendor-lock.json";

/**
 * What the lock was called before the declaration file existed.
 *
 * Read for its presence alone, never for its content. A tree still carrying it
 * has a lock this tool would otherwise not find, and a lock not found reads as
 * "nothing is resolved" — the next gen would retire every resolution the tree
 * records and rewrite every copy from scratch, reporting an initial adoption
 * for text that had been pinned all along.
 */
export const SUPERSEDED_LOCK_FILE = "vendor-manifest.json";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

export interface Resolution {
  digest: string;
  conformance?: string;
}

export type Resolutions = Record<string, Resolution>;

/**
 * Where one source's contracts were taken from, and at which commit.
 *
 * The revision is a commit SHA and never the branch or tag a declaration may
 * name: a branch moves, so a lock recording one would answer "which bytes were
 * adopted" differently on two days with nothing having been adopted in
 * between.
 *
 * The repository stands beside it although the declaration already says it.
 * The revision alone means nothing without the repository it belongs to, and a
 * lock read on its own — by the reviewer of the diff it lands in, by the
 * command that fetches what it names — must not have to hold the declaration
 * open beside it to say what was pinned.
 */
export interface LockSource {
  repository: string;
  revision: string;
}

export type LockSources = Record<string, LockSource>;

const REVISION_FORM = /^[0-9a-f]{40}$/;
const REPOSITORY_FORM =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The lock's canonical rendering: keys sorted at every level, two-space
 * indentation, one trailing newline, and no escaping of non-ASCII text.
 *
 * Verify compares the lock byte for byte, so a canonical rendering is what
 * makes "the lock is up to date" a decidable question rather than a question
 * about JSON formatting.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(withSortedKeys(value), null, 2) + "\n";
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = emptyRecord();
  for (const key of Object.keys(source).sort(compareStrings)) {
    sorted[key] = withSortedKeys(source[key]);
  }
  return sorted;
}

/**
 * The lock as the declarations, the resolutions and the present contracts
 * render to it: what each skill declares, what each contract resolved to, and
 * which commit each source was pinned at.
 *
 * `present` names the contracts whose canonical file the tree actually holds,
 * and it limits what is recorded. A resolution kept for a withdrawn contract
 * answers no question: nothing can rewrite it (the text is not there) and
 * nothing can verify it, while a conformance digest recorded for it fails
 * every run that checks conformance. Pruning resolutions to the present
 * contracts is what lets one `gen` recover a tree whose contract was
 * withdrawn.
 *
 * The two halves stay logically separate because adding a dependency and
 * changing what a contract says are different acts: mixed into one map they
 * would read as the same kind of diff.
 */
export function buildLock(
  dependencies: Dependencies,
  resolutions: Resolutions,
  present: string[],
  sources: LockSources,
): unknown {
  const resolved: Resolutions = emptyRecord();
  for (const id of [...present].sort(compareStrings)) {
    resolved[id] = resolutions[id];
  }
  // No wall-clock value is recorded anywhere in here. Reproducibility is the
  // reason this file exists, and a timestamp would make every regeneration a
  // change.
  const lock: Record<string, unknown> = { dependencies, resolutions: resolved };
  // A tree that fetches nothing renders the two halves the lock has always
  // had, byte for byte. Written as an empty object instead, every repository
  // with no remote source at all would carry a key answering a question it
  // never asks — and the absence of the key is what lets such a tree be
  // migrated by renaming the file and nothing else.
  if (Object.keys(sources).length > 0) lock["sources"] = sources;
  return lock;
}

/**
 * The canonical text of the lock the tree renders to.
 *
 * gen writes exactly this and verify compares the file against exactly this,
 * so the rendering is stated once here rather than twice — spelled twice, a
 * change to one side would make gen and verify silently disagree about what
 * "up to date" means.
 */
export async function renderExpectedLock(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
  sources: LockSources,
  locations: Map<string, ContractLocation>,
): Promise<string> {
  return canonicalJson(
    buildLock(
      dependenciesOf(skills),
      resolutions,
      await presentContractIds(root, resolutions, locations),
      sources,
    ),
  );
}

/**
 * The resolved contracts the tree still accounts for.
 *
 * Every command that renders the lock asks this one question through this one
 * function. Two commands answering it differently would make the lock gen
 * writes differ from the lock verify expects, and the difference would be
 * reported as a stale file that regenerating never fixes.
 *
 * What counts as accounted for depends on who is authority over the text. For a
 * local contract it is the canonical file being there, as it always was. For a
 * remote one it is the mapping being recorded in the declaration, and the cache
 * has no say at all: a clean checkout holds no cache, and a rule that read the
 * cache would drop every remote resolution from the lock a checkout renders —
 * turning the one comparison that still works without a network into a
 * guaranteed mismatch.
 *
 * The ids come from the lock rather than from any declaration, so this reaches
 * the canonical file of a contract nothing declares any more. The link check
 * therefore belongs here too, and the conformance tests beside the text are
 * covered by it on the same grounds: whether a link is refused is a fact about
 * the tree, not about which command is looking, and left out here a link
 * planted at such a contract stopped verify — which digests those tests — while
 * the run that rendered the lock carried on.
 */
async function presentContractIds(
  root: string,
  resolutions: Resolutions,
  locations: Map<string, ContractLocation>,
): Promise<string[]> {
  const present: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    const location = locations.get(id);
    if (location === undefined) {
      throw new ConfigError(
        `cannot render the lock for ${id}: its origin was never resolved`,
      );
    }
    if (!location.local) {
      present.push(id);
      continue;
    }
    await assertPlainContractPaths(root, location.site, id);
    if (await isRegularFileOrAbsent(root, location.site)) present.push(id);
  }
  return present;
}

/**
 * What the lock records about the tree it was written from.
 *
 * Read as one document because it is one: a command that asks what text was
 * pinned and a command that asks which names were skills must not be able to
 * see two different locks.
 */
interface Lock {
  /**
   * The skills the lock records a dependency list for — the tree's own
   * memory of which names under skills/ were skill directories when it was
   * last written. It is what tells a name that has stopped being a directory
   * apart from a file that was never a skill at all.
   */
  recordedSkills: ReadonlySet<string>;
  resolutions: Resolutions;
  /**
   * The commit each source was pinned at. Written only by the commands that
   * reach the network, and carried across by every command that does not, so
   * an offline run never drops the pin a fetch would have to restore from.
   */
  sources: LockSources;
}

/**
 * An empty map of resolutions, and the only place one is made.
 *
 * Every path that answers "nothing is resolved" comes through here: a tree
 * with no lock, a lock recording no resolutions, and the map the recorded ones
 * are read into. Kept as one place so a fourth path cannot answer differently.
 */
function emptyResolutions(): Resolutions {
  return emptyRecord();
}

/** The lock currently recorded, or an empty one where the tree has none yet. */
export async function readLock(root: string): Promise<Lock> {
  await assertPlainChain(root, LOCK_FILE);
  // Asked before the file is opened, and this is the read that makes it matter:
  // every command reads the lock before it does anything else, so a named pipe
  // standing here blocked all of them where nothing else in the run had yet
  // looked at the path. A tree with no lock still has no resolutions.
  if (!(await isRegularFileOrAbsent(root, LOCK_FILE))) {
    await assertNoSupersededLock(root);
    return {
      recordedSkills: new Set(),
      resolutions: emptyResolutions(),
      sources: emptySources(),
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(`${root}/${LOCK_FILE}`);
  } catch (cause) {
    throw new ConfigError(`cannot read ${LOCK_FILE}: ${describeCause(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, LOCK_FILE));
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `${LOCK_FILE}: not readable JSON: ${describeCause(cause)}`,
    );
  }
  const document = pickObject(parsed, "");
  const rawDependencies = document["dependencies"];
  // A manifest must carry both halves of the lock. The one empty lock is the
  // whole file being absent, which is answered before JSON is ever read; a
  // file present but missing a half is a hand-corrupted state, and reading it
  // as "no skills recorded" would let the next gen forget every skill the tree
  // records a dependency list for.
  //
  // A manifest written by a superseded form of this tool is refused by the
  // same check rather than by a format marker: the earlier form wrapped both
  // halves in a `lock` key, so its dependencies are not where a manifest keeps
  // them and the absence of the field is itself the mark of the old form.
  if (rawDependencies === undefined) {
    throw new ConfigError(`${LOCK_FILE}: has no dependencies key`);
  }
  return {
    recordedSkills: new Set(
      Object.keys(pickObject(rawDependencies, "dependencies")),
    ),
    resolutions: validateResolutions(document),
    sources: validateSources(document),
  };
}

/** An empty map of sources, and the only place one is made. */
function emptySources(): LockSources {
  return emptyRecord();
}

/**
 * The sources the lock records, or none where it carries no sources key.
 *
 * An absent key is read as "no source", never refused. It is what a tree that
 * fetches nothing renders to, so refusing it would make every repository with
 * only local contracts unreadable — the opposite of the two halves the lock
 * has always carried, where an absent key marks a file somebody cut in half.
 */
function validateSources(document: Record<string, unknown>): LockSources {
  const raw = document["sources"];
  if (raw === undefined) return emptySources();
  const entries = pickObject(raw, "sources");
  const sources: LockSources = emptySources();
  for (const name of Object.keys(entries)) {
    const entry = pickObject(entries[name], `sources.${name}`);
    sources[name] = {
      repository: requireMatch(
        entry["repository"],
        REPOSITORY_FORM,
        `sources.${name}.repository`,
        "an owner/repo pair",
      ),
      revision: requireMatch(
        entry["revision"],
        REVISION_FORM,
        `sources.${name}.revision`,
        "a 40-digit commit SHA",
      ),
    };
  }
  return sources;
}

/**
 * Refuses a tree that still carries the lock under the name it had before the
 * declaration file existed.
 *
 * Asked only where no lock was found, since that is the whole danger: the
 * absent lock is read as "nothing is resolved anywhere", and the next gen
 * would rewrite every copy and report an initial adoption for text the tree
 * had pinned all along. The refusal names both files rather than describing
 * the situation, because renaming the one into the other is the entire
 * migration — the content of the old file is already the content of the new
 * one.
 */
async function assertNoSupersededLock(root: string): Promise<void> {
  await assertPlainChain(root, SUPERSEDED_LOCK_FILE);
  if (!(await isRegularFileOrAbsent(root, SUPERSEDED_LOCK_FILE))) return;
  throw new ConfigError(
    `${SUPERSEDED_LOCK_FILE} is the name this tool's lock had before ` +
      `${LOCK_FILE}: rename the file to ${LOCK_FILE}`,
  );
}

function validateResolutions(document: Record<string, unknown>): Resolutions {
  const raw = document["resolutions"];
  // The same refusal as a lock missing its dependencies, for the other half:
  // the lock this tool writes always carries both, and reading an absent half
  // as empty would let the next gen silently drop what it recorded.
  if (raw === undefined) {
    throw new ConfigError(`${LOCK_FILE}: has no resolutions key`);
  }
  const entries = pickObject(raw, "resolutions");
  const resolutions: Resolutions = emptyResolutions();
  for (const id of Object.keys(entries)) {
    assertValidContractId(id, `${LOCK_FILE}: resolutions`);
    const entry = pickObject(entries[id], `resolutions.${id}`);
    const resolution: Resolution = {
      digest: requireDigest(entry["digest"], `resolutions.${id}.digest`),
    };
    if (entry["conformance"] !== undefined) {
      resolution.conformance = requireDigest(
        entry["conformance"],
        `resolutions.${id}.conformance`,
      );
    }
    resolutions[id] = resolution;
  }
  return resolutions;
}

function pickObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${LOCK_FILE}: ${path || "document"} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireDigest(value: unknown, path: string): string {
  return requireMatch(value, DIGEST_FORM, path, "a sha256 digest");
}

/**
 * A recorded value that has to be text of a fixed shape, or a refusal naming
 * what was wanted and what stood there.
 *
 * The lock is written by this tool alone, so every one of these refusals is
 * about a hand-edited file. The shapes are still checked rather than trusted:
 * a revision reaches a URL and a repository name reaches a host, and text that
 * was never checked is text an edit can steer.
 */
function requireMatch(
  value: unknown,
  form: RegExp,
  path: string,
  wanted: string,
): string {
  if (typeof value !== "string" || !form.test(value)) {
    throw new ConfigError(
      `${LOCK_FILE}: ${path} must be ${wanted}, found ${JSON.stringify(value)}`,
    );
  }
  return value;
}
