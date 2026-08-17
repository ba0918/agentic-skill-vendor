// gen.ts — writing the canonical contracts into the skills that declare them,
// and the lock that records what was written.
//
// The distribution half of the tool. It reads the canonical contracts, decides
// whether the tree is in a state worth writing, and expands it — building every
// byte before writing any of them, so a tree is never half-updated over
// something the run could have known in advance.
//
// verify.ts builds on this module rather than beside it: it checks what this
// module would write, so both share one answer to "may this tree be expanded at
// all" instead of restating it.

import * as fs from "node:fs/promises";
import { ConfigError, describeCause, type Sink } from "./errors.ts";
import {
  canonicalBody,
  CONTRACTS_DIR,
  compareStrings,
  contractPath,
  digestOfText,
} from "./digest.ts";
import { assertPlainContractPaths, conformanceDigest } from "./conformance.ts";
import {
  assertPlainChain,
  assertTreeRoot,
  atomicWriteFile,
  displayName,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  listEntries,
  readTextFile,
} from "./walk.ts";
import {
  declaredIds,
  dependentIndex,
  readSkills,
  type SkillDeclaration,
  SKILLS_DIR,
} from "./declaration.ts";
import { emptyRecord } from "./records.ts";
import {
  MANIFEST_FILE,
  readLock,
  renderExpectedManifest,
  type Resolution,
  type Resolutions,
} from "./manifest.ts";

const VENDOR_SUBPATH = "references/vendor";

/**
 * The name the vendored copy header credits the generation to.
 *
 * Frozen at `agentic-skill-vendor` from here on. It is a value on the wire, not
 * a path: it sits in bytes that verify compares exactly, so changing it reports
 * every already generated copy in every consuming repository as drift. It was
 * `vendor.ts` — the name of the single file the tool used to be — and moving it
 * to the published name is the last time it may move, taken while no version
 * has been released and no copy exists to break.
 *
 * The name is all that is left of what used to be a generator record. The
 * version and the repository URL that stood beside it were written into the
 * manifest, where no check consumed them and the version made a release of the
 * tool fail every consuming repository's verify.
 */
const GENERATOR_NAME = "agentic-skill-vendor";

export function vendorDirOf(skill: string): string {
  return `${SKILLS_DIR}/${skill}/${VENDOR_SUBPATH}`;
}

/**
 * Reads each contract's canonical text, or null where the file is absent.
 *
 * The whole path is checked for links, not just the file at the end of it. A
 * link at `contracts/` makes every contract below it resolve outside the tree,
 * and the run would then digest outside text, pin it, and write it into every
 * vendored copy while reporting nothing — the escape this tool exists to close.
 *
 * The conformance tests beside the text are covered by the same check, although
 * nothing read here lies below their directory. That is the whole point of
 * asking it here: left to the commands that do read them, a link planted there
 * stopped verify while gen expanded the tree without a word.
 *
 * Null means the canonical file is not there at all, and nothing else. Anything
 * standing at the path that is not a file the run can read stops it instead:
 * carried as null it would be reported as a closure gap, which states that the
 * tree does not hold the text — a claim about the tree the run is in no
 * position to make. Keeping the two apart is also what leaves that report
 * truthful, since the only way left to reach it is a file genuinely absent.
 */
export async function readContracts(
  root: string,
  ids: string[],
): Promise<Map<string, CanonicalContract | null>> {
  const contracts = new Map<string, CanonicalContract | null>();
  if (ids.length === 0) return contracts;
  // A file standing at contracts/ made every contract below it read as "does
  // not exist" — the per-path lstat fails with ENOTDIR, which is not the
  // "nothing is there" this function answers with. Asked once, the fact is
  // named as what it is before any contract is looked up.
  await isDirectoryOrAbsent(root, CONTRACTS_DIR);
  for (const id of ids) {
    const site = contractPath(id);
    await assertPlainContractPaths(root, id);
    if (!(await isRegularFileOrAbsent(root, site))) {
      contracts.set(id, null);
      continue;
    }
    const text = await readTextFile(`${root}/${site}`, site);
    const body = canonicalBody(text, site);
    contracts.set(id, { digest: await digestOfText(body), body });
  }
  return contracts;
}

interface CanonicalContract {
  digest: string;
  body: string;
}

/**
 * The bytes of a vendored copy: the three facts the specification fixes, then
 * the canonical body.
 *
 * No source path and no time of generation appear. A path would make the copy
 * depend on where it came from, and a timestamp would make two runs over
 * unchanged input produce different files.
 */
export function renderVendorFile(
  id: string,
  digest: string,
  body: string,
): string {
  return vendorHeader(id, digest) + body;
}

/** The fixed prefix of a vendored copy, rebuilt from an id and a pinned digest. */
export function vendorHeader(id: string, digest: string): string {
  return (
    `<!-- DO NOT EDIT. Generated by ${GENERATOR_NAME}. -->\n` +
    `<!-- contract: ${id} -->\n` +
    `<!-- source-digest: ${digest} -->\n\n`
  );
}

/** The names directly inside a skill's vendor directory. */
export async function listVendorEntries(
  root: string,
  skill: string,
): Promise<string[]> {
  const relative = vendorDirOf(skill);
  await assertPlainChain(root, relative);
  if (!(await isDirectoryOrAbsent(root, relative))) return [];
  const dir = `${root}/${relative}`;
  return (await listEntries(dir, relative)).map((entry) => entry.name);
}

/**
 * Every path in a plan is relative to the tree, never absolute. The plan is
 * then a statement about the tree rather than about where the tree happens to
 * sit, and it is the same relative path that every refusal quotes back.
 */
interface WritePlan {
  files: { site: string; content: Uint8Array }[];
  manifest: { site: string; content: Uint8Array };
  removals: string[];
}

/**
 * Builds every byte the run will write before writing any of them, so that a
 * tree is never half-updated because of something the run could have known in
 * advance.
 */
export async function planExpansion(
  root: string,
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  resolutions: Resolutions,
): Promise<WritePlan> {
  const encoder = new TextEncoder();
  const files: WritePlan["files"] = [];
  const removals: string[] = [];
  for (const skill of skills) {
    const expected = new Set<string>();
    for (const id of skill.contracts) {
      const contract = contracts.get(id);
      // gen refuses a missing canonical text before planning, so neither
      // spelling is reachable from it; a future caller that forgets the
      // closure check is refused here instead of writing a manifest that
      // silently dropped the contract.
      if (contract === undefined) {
        throw new ConfigError(
          `cannot plan ${id}: its canonical text was never read`,
        );
      }
      if (contract === null) {
        throw new ConfigError(
          `cannot plan ${id}: ${contractPath(id)} does not exist`,
        );
      }
      expected.add(`${id}.md`);
      files.push({
        site: `${vendorDirOf(skill.name)}/${id}.md`,
        content: encoder.encode(
          renderVendorFile(id, contract.digest, contract.body),
        ),
      });
    }
    for (const name of await listVendorEntries(root, skill.name)) {
      if (!expected.has(name)) {
        removals.push(`${vendorDirOf(skill.name)}/${name}`);
      }
    }
  }
  return {
    files,
    manifest: {
      site: MANIFEST_FILE,
      content: encoder.encode(
        await renderExpectedManifest(root, skills, resolutions),
      ),
    },
    removals,
  };
}

/**
 * Copies first, then the manifest, then the removals.
 *
 * A run stopped part way therefore never loses a file it had not yet replaced,
 * and the state it leaves is one verify reports as a violation rather than one
 * that looks finished.
 *
 * A removal that fails is reported rather than passed over. Because removals
 * run last, stopping here abandons nothing: every copy and the lock are already
 * written, and what the refusal names is the one file the run could not clear.
 * Silence cost more than it saved — gen answered 0 while verify reported the
 * leftover as an extra, and running gen again answered 0 again, so the tree
 * stayed in a state one command called clean and the other called a violation.
 */
export async function executePlan(
  root: string,
  plan: WritePlan,
): Promise<void> {
  for (const file of plan.files) {
    await atomicWriteFile(root, file.site, file.content);
  }
  await atomicWriteFile(root, plan.manifest.site, plan.manifest.content);
  const failures: { site: string; cause: unknown }[] = [];
  for (const site of plan.removals) {
    try {
      // A path already gone is the state this asks for, not a failure: `force`
      // is what separates "there is nothing to remove" from "this could not be
      // removed", and only the second is worth stopping over.
      await fs.rm(`${root}/${site}`, { recursive: true, force: true });
    } catch (cause) {
      // Every removal is attempted before any of them is reported, so one file
      // that cannot be cleared does not leave the rest standing behind it.
      failures.push({ site, cause });
    }
  }
  if (failures.length > 0) {
    const [first] = failures;
    throw new ConfigError(
      `cannot remove ${displayName(first.site)}: ${describeCause(first.cause)}`,
    );
  }
}

/**
 * The declared contracts whose canonical text the tree does not hold.
 *
 * The one gate gen applies before it writes anything. The canonical text is the
 * authority over what the lock records, so there is nothing else for gen to
 * refuse: a contract the lock says nothing about, or says something else about,
 * is a lock gen rewrites rather than a state it stops on. Text that is not
 * there is different in kind — it cannot be rewritten from, and a run that
 * carried on would drop the resolution of a contract a skill still declares.
 */
export function closureViolations(
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
): string[] {
  const violations: string[] = [];
  const dependentsOfId = dependentIndex(skills);
  for (const id of declaredIds(skills)) {
    if ((contracts.get(id) ?? null) !== null) continue;
    const dependents = (dependentsOfId.get(id) ?? [])
      .map(displayName)
      .join(", ");
    violations.push(
      `closure: ${id} is declared by ${dependents} but ${contractPath(
        id,
      )} does not exist`,
    );
  }
  return violations;
}

/**
 * What the lock records, against what the canonical text says.
 *
 * verify's half alone: gen answers these by writing the lock the canonical text
 * implies, so it can never report one. What this catches is the tree gen was
 * never run over — the edit landed, the lock still records the text before it —
 * which is the state continuous integration exists to fail on.
 *
 * A contract whose canonical text is absent is passed over rather than reported
 * twice: it is already named as a closure gap, and the lock cannot be judged
 * against text the tree does not hold.
 *
 * Stated here rather than in verify.ts, its one caller, because it and the
 * closure check are two halves of one answer — whether the lock agrees with the
 * canonical text — and the halves have to move together. Split across modules,
 * a change to which contracts one of them walks would land in one half and not
 * the other, and the gap would read as a clean tree.
 */
export function lockViolations(
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  resolutions: Resolutions,
): string[] {
  const violations: string[] = [];
  // The same contracts gen would rewrite the lock over, not the declared ones
  // alone. Walked over the declarations only, this judged a narrower set than
  // gen acts on: editing the canonical text of a contract nothing declares any
  // more left the tree reported as clean, and the next gen recorded the new
  // digest with nothing having said the text moved.
  for (const id of lockedOrDeclared(skills, resolutions)) {
    const contract = contracts.get(id) ?? null;
    if (contract === null) continue;
    const resolution = resolutions[id];
    // Only a declaration can be unresolved: it is the declaration that asks for
    // a pin, and an id reached through the lock has one by definition. Reported
    // for a contract nothing declares, every stray document under contracts/
    // would become a violation.
    if (resolution === undefined) {
      violations.push(
        `unresolved: ${id} has no entry in ${MANIFEST_FILE}; run gen to record one`,
      );
      continue;
    }
    if (resolution.digest !== contract.digest) {
      violations.push(
        `stale-lock: ${id} is recorded as ${resolution.digest} but ${contractPath(
          id,
        )} is ${contract.digest}; run gen to record the current text`,
      );
    }
  }
  return violations;
}

/**
 * The tree read every command starts with: the root checked, the lock read,
 * the skills read from the names the lock remembers.
 *
 * gen and verify read the exact same preamble before they part ways. One place
 * for the preamble is what makes a change to how tree state is read land in
 * both at once instead of in whichever command the author happened to touch.
 */
export interface TreeState {
  resolutions: Resolutions;
  skills: SkillDeclaration[];
}

export async function readTreeState(root: string): Promise<TreeState> {
  await assertTreeRoot(root);
  const { recordedSkills, resolutions } = await readLock(root);
  const skills = await readSkills(root, recordedSkills);
  return { resolutions, skills };
}

/**
 * Every contract this run has to read: the ones a skill declares, and the ones
 * the lock already records.
 *
 * The lock is rewritten from the canonical text, so a contract the lock records
 * has to be read even when nothing declares it any more. Left carried across
 * untouched, a conformance tree edited beside such a contract failed
 * verification with nothing able to record the new value — the one command that
 * could was the approval command, and it is gone.
 */
function lockedOrDeclared(
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): string[] {
  return [
    ...new Set([...declaredIds(skills), ...Object.keys(resolutions)]),
  ].sort(compareStrings);
}

/**
 * The canonical text of every contract a run has to look at, read once.
 *
 * Asked through this one function by gen and by verify, because the two must not
 * disagree about which contracts a tree holds. Each calling `readContracts` with
 * its own list is how they came apart: verify passed the declared ids while gen
 * passed the declared ids and the recorded ones, so a contract only the lock
 * named was rewritten by one command and never judged by the other.
 */
export async function readTreeContracts(
  root: string,
  skills: SkillDeclaration[],
  resolutions: Resolutions,
): Promise<Map<string, CanonicalContract | null>> {
  return await readContracts(root, lockedOrDeclared(skills, resolutions));
}

/**
 * The lock the canonical text implies: one resolution per contract the tree
 * holds text for, its digest recomputed and its conformance digest taken as the
 * tree has it.
 *
 * Derived rather than carried across, because the canonical text is the
 * authority and the lock is the snapshot of it (the relation package.json has
 * to a lockfile). A contract whose text is gone is left out, which is what
 * retires its resolution.
 */
async function deriveResolutions(
  root: string,
  contracts: Map<string, CanonicalContract | null>,
): Promise<Resolutions> {
  const resolutions = emptyRecord<Resolution>();
  for (const id of [...contracts.keys()].sort(compareStrings)) {
    const contract = contracts.get(id) ?? null;
    if (contract === null) continue;
    const resolution: Resolution = { digest: contract.digest };
    const conformance = await conformanceDigest(root, id);
    if (conformance !== null) resolution.conformance = conformance;
    resolutions[id] = resolution;
  }
  return resolutions;
}

/**
 * What the run changed about the lock, one line each.
 *
 * Not a gate — a change summary to paste into a pull request, and the join a
 * consuming repository's regression machinery matches its evidence against. A
 * recorded pass or fail alone cannot tell adopting this text from adopting some
 * third version, so both digests are named. The same values appear in the
 * lock's own diff; this states them where the run that made them is read.
 */
function rewriteReport(recorded: Resolutions, derived: Resolutions): string[] {
  const lines: string[] = [];
  for (const id of Object.keys(derived).sort(compareStrings)) {
    lines.push(...rewrittenValues(id, recorded[id], derived[id]));
  }
  // The resolutions the rewritten lock drops whole. Their conformance digest
  // went with them, and is not reported a second time: one removal, one line.
  for (const id of Object.keys(recorded).sort(compareStrings)) {
    if (id in derived) continue;
    lines.push(
      `retired: ${id} (no canonical text; resolution removed from the lock)`,
    );
  }
  return lines;
}

/**
 * What one contract's resolution changed, one line per value that moved.
 *
 * Two values can move independently, so they are reported independently rather
 * than folded into one line: folded, a reader would have to parse the line to
 * learn which digest moved, and the text form a consuming repository matches its
 * evidence against would change shape whenever the conformance tree happened to
 * move in the same run.
 *
 * The conformance digest earns a line of its own for the reason the text digest
 * does. It is the compatibility evidence the specification asks to be bound at
 * the moment of adoption, so a run that swapped which evidence the lock names
 * cannot be indistinguishable from a run that changed nothing. Losing the tests
 * is reported as a retirement rather than an adoption: a value left the lock and
 * nothing was taken up in its place, which is what `retired` already says.
 *
 * The text digest has no removal form, and the two shapes are not unified for
 * that reason: a resolution always carries a text digest, so "the text digest
 * left the lock" is not a state this can reach — only the whole resolution can
 * go, which the caller reports.
 */
function rewrittenValues(
  id: string,
  recorded: Resolution | undefined,
  derived: Resolution,
): string[] {
  const lines: string[] = [];
  if (recorded?.digest !== derived.digest) {
    lines.push(
      recorded === undefined
        ? `adopted: ${id} ${derived.digest} (initial adoption)`
        : `adopted: ${id} ${recorded.digest} -> ${derived.digest}`,
    );
  }
  const before = recorded?.conformance;
  const after = derived.conformance;
  if (before === after) return lines;
  if (after === undefined) {
    lines.push(
      `retired: ${id} conformance ${before} ` +
        `(no conformance tests; digest removed from the lock)`,
    );
  } else if (before === undefined) {
    lines.push(`adopted: ${id} conformance ${after} (initial adoption)`);
  } else {
    lines.push(`adopted: ${id} conformance ${before} -> ${after}`);
  }
  return lines;
}

/**
 * Writes the lock the canonical text implies and the copies that go with it.
 *
 * The canonical text is the authority; there is no approval step between an
 * edit and the lock recording it. What guards a change of contract text is the
 * review of the pull request the rewritten lock appears in, and this run's job
 * is to make that diff exist and to say in one line what it changed.
 */
export async function commandGen(root: string, out: Sink): Promise<number> {
  const { resolutions: recorded, skills } = await readTreeState(root);
  const contracts = await readTreeContracts(root, skills, recorded);
  const violations = closureViolations(skills, contracts);
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  const derived = await deriveResolutions(root, contracts);
  const plan = await planExpansion(root, skills, contracts, derived);
  await executePlan(root, plan);
  for (const line of rewriteReport(recorded, derived)) out(line);
  return 0;
}
