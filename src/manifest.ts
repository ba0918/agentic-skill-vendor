// manifest.ts — the lock, in one canonical form.
//
// Verify compares the manifest byte for byte, so "the manifest is up to date"
// has to be a decidable question rather than a question about JSON formatting.
// One rendering, stated here, is what makes it decidable.
//
// The file holds the lock and nothing else. Every metadata field it used to
// carry — the tool's own version, the repository it came from, the source path
// of each contract — was a value no check consumed, and the tool's version in
// particular put a byte nobody verified into the comparison: releasing a new
// version of the tool made every consuming repository's verify fail until the
// tree was regenerated.

import * as fs from "node:fs/promises";
import { ConfigError, describeCause } from "./errors.ts";
import {
  assertValidContractId,
  compareStrings,
  contractPath,
} from "./digest.ts";
import { assertPlainContractPaths } from "./conformance.ts";
import { emptyRecord } from "./records.ts";
import { assertPlainChain, decodeUtf8, isRegularFileOrAbsent } from "./walk.ts";
import {
  dependenciesOf,
  type Dependencies,
  type SkillDeclaration,
} from "./declaration.ts";

/** The one file the lock lives in. */
export const MANIFEST_FILE = "vendor-manifest.json";
const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

export interface Resolution {
  digest: string;
  conformance?: string;
}

export type Resolutions = Record<string, Resolution>;

/**
 * The manifest's canonical rendering: keys sorted at every level, two-space
 * indentation, one trailing newline, and no escaping of non-ASCII text.
 *
 * Verify compares the manifest byte for byte, so a canonical rendering is what
 * makes "the manifest is up to date" a decidable question rather than a
 * question about JSON formatting.
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
 * The manifest as the declarations, the resolutions and the present contracts
 * render to it: the two halves of the lock and nothing else.
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
export function buildManifest(
  dependencies: Dependencies,
  resolutions: Resolutions,
  present: string[],
): unknown {
  const resolved: Resolutions = emptyRecord();
  for (const id of [...present].sort(compareStrings)) {
    resolved[id] = resolutions[id];
  }
  // No wall-clock value is recorded anywhere in here. Reproducibility is the
  // reason this file exists, and a timestamp would make every regeneration a
  // change.
  return { dependencies, resolutions: resolved };
}

/**
 * The canonical text of the manifest the tree renders to.
 *
 * gen writes exactly this and verify compares the file against exactly this,
 * so the rendering is stated once here rather than twice — spelled twice, a
 * change to one side would make gen and verify silently disagree about what
 * "up to date" means.
 */
export async function renderExpectedManifest(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): Promise<string> {
  return canonicalJson(
    buildManifest(
      dependenciesOf(skills),
      resolutions,
      await presentContractIds(root, resolutions),
    ),
  );
}

/**
 * The resolved contracts whose canonical file the tree holds.
 *
 * Every command that renders a manifest asks this one question through this one
 * function. Two commands answering it differently would make the manifest gen
 * writes differ from the manifest verify expects, and the difference would be
 * reported as a stale manifest that regenerating never fixes.
 *
 * The ids come from the lock rather than from any declaration, so this reaches
 * contracts/ for a contract nothing declares any more. The link check therefore
 * belongs here too, and the conformance tests beside the text are covered by it
 * on the same grounds: whether a link is refused is a fact about the tree, not
 * about which command is looking, and left out here a link planted at such a
 * contract stopped verify — which digests those tests — while the run that
 * rendered the manifest carried on.
 */
async function presentContractIds(
  root: string,
  resolutions: Resolutions,
): Promise<string[]> {
  const present: string[] = [];
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    const site = contractPath(id);
    await assertPlainContractPaths(root, id);
    if (await isRegularFileOrAbsent(root, site)) present.push(id);
  }
  return present;
}

/**
 * What the manifest records about the tree it was written from.
 *
 * Read as one document because it is one: a command that asks what text was
 * pinned and a command that asks which names were skills must not be able to
 * see two different manifests.
 */
interface Lock {
  /**
   * The skills the manifest records a dependency list for — the tree's own
   * memory of which names under skills/ were skill directories when it was
   * last written. It is what tells a name that has stopped being a directory
   * apart from a file that was never a skill at all.
   */
  recordedSkills: ReadonlySet<string>;
  resolutions: Resolutions;
}

/**
 * An empty map of resolutions, and the only place one is made.
 *
 * Every path that answers "nothing is resolved" comes through here: a tree
 * with no manifest, a lock recording no resolutions, and the map the recorded
 * ones are read into. Kept as one place so a fourth path cannot answer
 * differently.
 */
function emptyResolutions(): Resolutions {
  return emptyRecord();
}

/** The lock currently recorded, or an empty one when there is no manifest yet. */
export async function readLock(root: string): Promise<Lock> {
  await assertPlainChain(root, MANIFEST_FILE);
  // Asked before the file is opened, and this is the read that makes it matter:
  // every command reads the lock before it does anything else, so a named pipe
  // standing here blocked all of them where nothing else in the run had yet
  // looked at the path. A tree with no manifest still has no resolutions.
  if (!(await isRegularFileOrAbsent(root, MANIFEST_FILE))) {
    return { recordedSkills: new Set(), resolutions: emptyResolutions() };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(`${root}/${MANIFEST_FILE}`);
  } catch (cause) {
    throw new ConfigError(
      `cannot read ${MANIFEST_FILE}: ${describeCause(cause)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, MANIFEST_FILE));
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `${MANIFEST_FILE}: not readable JSON: ${describeCause(cause)}`,
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
    throw new ConfigError(`${MANIFEST_FILE}: has no dependencies key`);
  }
  return {
    recordedSkills: new Set(
      Object.keys(pickObject(rawDependencies, "dependencies")),
    ),
    resolutions: validateResolutions(document),
  };
}

function validateResolutions(document: Record<string, unknown>): Resolutions {
  const raw = document["resolutions"];
  // The same refusal as a manifest missing its dependencies, for the other
  // half: the manifest this tool writes always carries both, and reading an
  // absent half as empty would let the next gen silently drop what it
  // recorded.
  if (raw === undefined) {
    throw new ConfigError(`${MANIFEST_FILE}: has no resolutions key`);
  }
  const entries = pickObject(raw, "resolutions");
  const resolutions: Resolutions = emptyResolutions();
  for (const id of Object.keys(entries)) {
    assertValidContractId(id, `${MANIFEST_FILE}: resolutions`);
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
      `${MANIFEST_FILE}: ${path || "document"} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST_FORM.test(value)) {
    throw new ConfigError(
      `${MANIFEST_FILE}: ${path} must be a sha256 digest, found ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value;
}
