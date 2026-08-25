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
import { ConfigError, describeCause } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { assertPlainContractPaths } from "./conformance.ts";
import {
  type ContractLocation,
  type Declaration,
  DECLARATION_FILE,
} from "./sources.ts";
import { emptyRecord } from "../records.ts";
import { assertPlainChain, isRegularFileOrAbsent } from "../filesystem/walk.ts";
import { dependenciesOf, type SkillDeclaration } from "./declaration.ts";

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
import {
  buildLock,
  type LockSources,
  type Placements,
  type Resolutions,
} from "./lock-model.ts";
import { canonicalJson, decodeLock, emptyDecodedLock } from "./lock-codec.ts";

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
/** The lock currently recorded, or an empty one where the tree has none yet. */
export async function readLock(root: string): Promise<Lock> {
  await assertPlainChain(root, LOCK_FILE);
  // Asked before the file is opened, and this is the read that makes it matter:
  // every command reads the lock before it does anything else, so a named pipe
  // standing here blocked all of them where nothing else in the run had yet
  // looked at the path. A tree with no lock still has no resolutions.
  if (!(await isRegularFileOrAbsent(root, LOCK_FILE))) {
    await assertNoSupersededLock(root);
    return emptyDecodedLock();
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(`${root}/${LOCK_FILE}`);
  } catch (cause) {
    throw new ConfigError(`cannot read ${LOCK_FILE}: ${describeCause(cause)}`);
  }
  return decodeLock(bytes);
}

/** An empty map of placements, and the only place one is made. */
async function assertNoSupersededLock(root: string): Promise<void> {
  await assertPlainChain(root, SUPERSEDED_LOCK_FILE);
  if (!(await isRegularFileOrAbsent(root, SUPERSEDED_LOCK_FILE))) return;
  throw new ConfigError(
    `${SUPERSEDED_LOCK_FILE} is the name this tool's lock had before ` +
      `${LOCK_FILE}: rename the file to ${LOCK_FILE}`,
  );
}
