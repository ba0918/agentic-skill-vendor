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
import {
  type ContractLocation,
  type Declaration,
  DECLARATION_FILE,
  destsCollide,
  isTreeRelativePath,
  reservedDestRefusal,
} from "./sources.ts";
import { emptyRecord } from "./records.ts";
import { classifyRepository } from "./repository.ts";
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
  /** Present on a raw-byte contract; a document contract carries no kind. */
  kind?: "raw";
}

export type Resolutions = Record<string, Resolution>;

/**
 * What the tool wrote at one dest of one skill: which contract, from which src,
 * and what the dest's own content digests to.
 *
 * Recorded per skill and per dest rather than per contract. The gate that
 * keeps gen from replacing a person's directory is a fact about one skill's
 * one path, and a record keyed by contract would call skill B's untouched
 * directory "already written" the moment skill A's was.
 */
export interface Placement {
  contract: string;
  src: string;
  digest: string;
}

/** skill → dest → what stands there. Directory dests keep their trailing slash. */
export type Placements = Record<string, Record<string, Placement>>;

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
  /** Absent is the canonical representation of the backwards-compatible SHA-1 format. */
  objectFormat?: "sha256";
}

export type LockSources = Record<string, LockSource>;

const SHA1_REVISION_FORM = /^[0-9a-f]{40}$/;
const SHA256_REVISION_FORM = /^[0-9a-f]{64}$/;

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
  placements: Placements,
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
  // The same rule for the placements: a tree distributing no raw bytes renders
  // no key for them. Carried as the lock holds them, never pruned here — the
  // record is gen's memory of what it wrote, and a rendering that dropped an
  // entry would make every other command forget a dest before gen swept it.
  if (Object.keys(placements).length > 0) lock["placements"] = placements;
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
  declaration: Declaration,
  placements: Placements,
  rawPresent?: string[],
): Promise<string> {
  return canonicalJson(
    buildLock(
      dependenciesOf(skills),
      resolutions,
      await presentContractIds(root, resolutions, locations, rawPresent),
      registeredSources(sources, declaration),
      placements,
    ),
  );
}

/**
 * The pins whose source the declaration still registers, each named with the
 * repository the declaration registers it at.
 *
 * A pin left for a withdrawn source names a version nothing can reach: no
 * mapping sends a run to it, and its cache directory is cleared by the next
 * fetch. The filter lives here rather than in the command that writes the
 * lock, because both the writing and the checking pass through this one
 * rendering — applied on one side only, gen and verify would disagree about
 * what "up to date" means, and the tree would be reported as stale by a run
 * that had just put it right.
 *
 * The repository is taken from the declaration rather than carried across from
 * the lock, although the revision beside it is carried. The declaration is
 * where a person writes which repository a source is, so it is the authority
 * over that field, and the lock records what was resolved from it. Rendered
 * from the lock's own value, the field was compared with itself: a lock naming
 * a repository the declaration does not register was the repository every fetch
 * went to, while the comparison against this rendering reported nothing.
 *
 * The revision cannot be reconciled the same way, and that is the whole reason
 * the pin exists: what the declaration holds is a ref, and turning a ref into a
 * commit is a resolution, taken by update and reviewed in the diff it lands in.
 */
function registeredSources(
  sources: LockSources,
  declaration: Declaration,
): LockSources {
  const kept: LockSources = emptyRecord();
  for (const name of Object.keys(sources)) {
    const registered = declaration.sources[name];
    if (registered === undefined) continue;
    kept[name] = {
      repository: registered.repository,
      revision: sources[name].revision,
      ...(sources[name].objectFormat === undefined
        ? {}
        : { objectFormat: sources[name].objectFormat }),
    };
  }
  return kept;
}

/**
 * One source the lock and the declaration do not agree about: the repository
 * the lock pins it to, and the one the declaration registers it at.
 *
 * The fact is computed in one place and phrased in two — a violation for the
 * command that reports, a refusal for the commands that stop — because a
 * second computation of it could disagree with the first, and the tree would
 * be refused by one command over a state another calls clean.
 */
interface DivergentSource {
  name: string;
  pinned: string;
  registered: string;
}

function divergentSources(
  sources: LockSources,
  declaration: Declaration,
): DivergentSource[] {
  const divergent: DivergentSource[] = [];
  for (const name of Object.keys(sources).sort(compareStrings)) {
    const registered = declaration.sources[name];
    // A pin for a source the declaration no longer registers is not a
    // disagreement about where that source is: it is a pin the rendering drops
    // whole, which the next gen writes out of the file.
    if (registered === undefined) continue;
    if (registered.repository === sources[name].repository) continue;
    divergent.push({
      name,
      pinned: sources[name].repository,
      registered: registered.repository,
    });
  }
  return divergent;
}

/**
 * The lock's pins that name a repository the declaration does not register it
 * at, one finding each.
 *
 * Reported rather than refused, because the tree reaches this state
 * legitimately: a person edits the repository in the declaration and has not
 * run update yet. It is the same class as a stale lock — the tree disagreeing
 * with itself — and the commands that act on the value stop over it instead.
 */
export function sourceViolations(
  sources: LockSources,
  declaration: Declaration,
): string[] {
  return divergentSources(sources, declaration).map(
    (source) =>
      `source-mismatch: ${LOCK_FILE} pins ${source.name} to ` +
      `${source.pinned} but ${DECLARATION_FILE} registers ` +
      `${source.registered}; run update to pin the registered repository`,
  );
}

/**
 * Refuses a run that would act on a pin naming a repository the declaration
 * does not register the source at.
 *
 * The commands that act on the value stop where the command that only looks
 * reports. A fetch takes bytes from the repository the pin names, and a gen
 * distributes what such a fetch left in the cache, so both would carry out an
 * instruction the tree contradicts elsewhere — and the gen would rewrite the
 * lock afterwards, leaving no trace that the two had ever disagreed.
 *
 * update is not refused here, and that is what makes this refusal a state a
 * tree can leave: update reads the repository and the ref from the declaration
 * alone, so it never acts on the pinned value at all — it replaces it, which is
 * the way on this refusal names.
 *
 * One source is named rather than all of them. The way out is the same command
 * for every one of them, and it resolves every registered source in one run.
 */
export function assertPinnedRepositories(
  sources: LockSources,
  declaration: Declaration,
): void {
  const [first] = divergentSources(sources, declaration);
  if (first === undefined) return;
  throw new ConfigError(
    `${LOCK_FILE} pins ${first.name} to ${first.pinned} while ` +
      `${DECLARATION_FILE} registers ${first.registered}; run update to pin ` +
      `the registered repository and take up what it holds`,
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
  rawPresent: string[] | undefined,
): Promise<string[]> {
  const present: string[] = [];
  const raw = rawPresent === undefined ? null : new Set(rawPresent);
  for (const id of Object.keys(resolutions).sort(compareStrings)) {
    // A raw-byte contract answers "is the material there" through the module
    // that reads it, since it has no single site to ask about here. A caller
    // that read no material — update, add — carries every raw resolution.
    if (resolutions[id].kind === "raw") {
      if (raw === null || raw.has(id)) present.push(id);
      continue;
    }
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
  /** What gen wrote where, for raw-byte contracts. Empty where none exist. */
  placements: Placements;
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
      placements: emptyPlacements(),
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
    placements: validatePlacements(document),
    sources: validateSources(document),
  };
}

/** An empty map of placements, and the only place one is made. */
function emptyPlacements(): Placements {
  return emptyRecord();
}

/**
 * The placements the lock records, or none where it carries no key.
 *
 * Every value here is a path the next gen may remove recursively, so each is
 * held to a shape before it is believed — the skill name to the shape of one
 * directory name, the dest to the shape of a path inside a skill — for the
 * reason a revision is: text that was never checked is text an edit can steer
 * into a deletion outside the tree.
 */
function validatePlacements(document: Record<string, unknown>): Placements {
  const raw = document["placements"];
  if (raw === undefined) return emptyPlacements();
  const skills = pickObject(raw, "placements");
  const placements: Placements = emptyPlacements();
  for (const skill of Object.keys(skills)) {
    if (!isPlainSkillName(skill)) {
      throw new ConfigError(
        `${LOCK_FILE}: placements names a skill that is not one directory ` +
          `name: ${JSON.stringify(skill)}`,
      );
    }
    const dests = pickObject(skills[skill], `placements.${skill}`);
    const entries: Record<string, Placement> = emptyRecord();
    for (const dest of Object.keys(dests)) {
      const path = `placements.${skill}.${dest}`;
      const bare = dest.replace(/\/$/, "");
      if (!isTreeRelativePath(bare)) {
        throw new ConfigError(
          `${LOCK_FILE}: ${path} is not a path inside the skill`,
        );
      }
      const reserved = reservedDestRefusal(bare);
      if (reserved !== null) {
        throw new ConfigError(`${LOCK_FILE}: ${path} names ${reserved}`);
      }
      for (const other of Object.keys(entries)) {
        if (destsCollide(other.replace(/\/$/, ""), bare)) {
          throw new ConfigError(
            `${LOCK_FILE}: ${path} is the same as or nests with ` +
              `placements.${skill}.${other}; two distributions cannot share ` +
              `a place`,
          );
        }
      }
      const entry = pickObject(dests[dest], path);
      const contract = requireText(entry["contract"], `${path}.contract`);
      assertValidContractId(contract, `${LOCK_FILE}: ${path}.contract`);
      entries[dest] = {
        contract,
        src: requireText(entry["src"], `${path}.src`),
        digest: requireDigest(entry["digest"], `${path}.digest`),
      };
    }
    placements[skill] = entries;
  }
  return placements;
}

/** True for a name that is exactly one directory segment. */
function isPlainSkillName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(
      `${LOCK_FILE}: ${path} must be text, found ${JSON.stringify(value)}`,
    );
  }
  return value;
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
    const objectFormat = readObjectFormat(
      entry["objectFormat"],
      `sources.${name}.objectFormat`,
    );
    const repository = requireText(
      entry["repository"],
      `sources.${name}.repository`,
    );
    try {
      classifyRepository(repository);
    } catch (cause) {
      if (cause instanceof ConfigError) {
        throw new ConfigError(
          `${LOCK_FILE}: sources.${name}.repository: ${cause.message}`,
        );
      }
      throw cause;
    }
    sources[name] = {
      repository,
      revision: requireMatch(
        entry["revision"],
        objectFormat === "sha256" ? SHA256_REVISION_FORM : SHA1_REVISION_FORM,
        `sources.${name}.revision`,
        objectFormat === "sha256"
          ? "a 64-digit SHA-256 commit object id"
          : "a 40-digit SHA-1 commit object id",
      ),
      ...(objectFormat === undefined ? {} : { objectFormat }),
    };
  }
  return sources;
}

function readObjectFormat(value: unknown, path: string): "sha256" | undefined {
  if (value === undefined) return undefined;
  if (value !== "sha256") {
    throw new ConfigError(
      `${LOCK_FILE}: ${path} must be "sha256" when present, found ${JSON.stringify(value)}`,
    );
  }
  return value;
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
    if (entry["kind"] !== undefined) {
      if (entry["kind"] !== "raw") {
        throw new ConfigError(
          `${LOCK_FILE}: resolutions.${id}.kind must be "raw" where present, ` +
            `found ${JSON.stringify(entry["kind"])}`,
        );
      }
      resolution.kind = "raw";
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
