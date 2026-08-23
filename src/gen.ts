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
  atomicWriteDirectory,
  atomicWriteFile,
  displayName,
  type PlacedFile,
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
import { vendorHeader } from "./header.ts";
export { vendorHeader } from "./header.ts";
import { cacheSiteOf } from "./cache.ts";
import {
  assertPinnedRepositories,
  LOCK_FILE,
  type LockSources,
  type Placements,
  readLock,
  renderExpectedLock,
  type Resolution,
  type Resolutions,
} from "./manifest.ts";
import {
  deriveRawResolutions,
  planPlacements,
  rawClosureViolations,
  type RawContracts,
  rawMappingsOf,
  readRawContracts,
} from "./placements.ts";
import {
  type ContractLocation,
  type Declaration,
  DECLARATION_FILE,
  LOCAL_SOURCE,
  originPathOf,
  parseDeclaration,
  readDeclaration,
  withContractMapping,
  withoutContractMapping,
} from "./sources.ts";

const VENDOR_SUBPATH = "references/vendor";

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
  locations: Map<string, ContractLocation>,
): Promise<Map<string, CanonicalContract | null>> {
  const contracts = new Map<string, CanonicalContract | null>();
  if (locations.size === 0) return contracts;
  // A file standing at contracts/ made every contract below it read as "does
  // not exist" — the per-path lstat fails with ENOTDIR, which is not the
  // "nothing is there" this function answers with. Asked once, the fact is
  // named as what it is before any contract is looked up.
  await isDirectoryOrAbsent(root, CONTRACTS_DIR);
  for (const [id, location] of locations) {
    const site = location.site;
    if (site === null) {
      contracts.set(id, null);
      continue;
    }
    await assertPlainContractPaths(root, site, id);
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

/**
 * Where this run reads each contract's canonical text.
 *
 * The declaration decides it, and the same answer serves the distribution, the
 * lock's rendering and every check — one place, because a run that read a
 * contract from one file while pinning what another file says is exactly the
 * drift this tool exists to make impossible.
 *
 * A contract no mapping names is local at the conventional position. That is
 * the shape of every repository that has never fetched anything, and it is why
 * an absent declaration changes nothing about how such a tree behaves.
 */
export async function locateContracts(
  root: string,
  declaration: Declaration,
  sources: LockSources,
  ids: string[],
): Promise<Map<string, ContractLocation>> {
  const locations = new Map<string, ContractLocation>();
  const raw = rawMappingsOf(declaration);
  for (const id of ids) {
    const origin = declaration.contracts[id];
    // A raw-byte contract has no single site: its material is read by the
    // placements module, and the lock's rendering asks that module whether
    // the tree holds it.
    if (raw.has(id)) continue;
    if (origin === undefined || origin.source === LOCAL_SOURCE) {
      locations.set(id, { local: true, site: originPathOf(id, origin) });
      continue;
    }
    // A remote contract is read out of the cache at the commit the lock pins,
    // and a cache that does not hold it yet is a state rather than a fault: a
    // clean checkout is in it. The commands part ways over what to do about
    // that, so what this answers is only whether the bytes are here.
    const pinned = sources[origin.source];
    if (pinned === undefined) {
      locations.set(id, { local: false, site: null });
      continue;
    }
    const site = cacheSiteOf(
      origin.source,
      pinned.revision,
      originPathOf(id, origin),
    );
    await assertPlainChain(root, site);
    locations.set(id, {
      local: false,
      site: (await isRegularFileOrAbsent(root, site)) ? site : null,
    });
  }
  return locations;
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
  directories: { site: string; files: PlacedFile[] }[];
  /** Raw-byte dests to clear: before the lock, which is their only memory. */
  sweeps: string[];
  lock: { site: string; content: Uint8Array };
  removals: string[];
  report: string[];
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
  sources: LockSources,
  locations: Map<string, ContractLocation>,
  declaration: Declaration,
  raws: RawContracts = new Map(),
  placements: Placements = emptyRecord(),
): Promise<WritePlan> {
  const encoder = new TextEncoder();
  const files: WritePlan["files"] = [];
  const directories: WritePlan["directories"] = [];
  const removals: string[] = [];
  const placed = await planPlacements(
    root,
    skills,
    raws,
    resolutions,
    placements,
  );
  for (const dest of placed.dests) {
    if (dest.mapping.kind === "directory") {
      directories.push({ site: dest.site, files: dest.files });
    } else {
      files.push({ site: dest.site, content: dest.files[0].content });
    }
  }
  for (const skill of skills) {
    const expected = new Set<string>();
    for (const id of skill.contracts) {
      if (raws.has(id)) continue;
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
          `cannot plan ${id}: its canonical text is absent`,
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
    directories,
    lock: {
      site: LOCK_FILE,
      content: encoder.encode(
        await renderExpectedLock(
          root,
          skills,
          resolutions,
          sources,
          locations,
          declaration,
          placed.placements,
          presentRawIds(raws),
        ),
      ),
    },
    sweeps: placed.sweeps,
    removals,
    report: placed.report,
  };
}

/** The raw-byte contracts whose material the tree holds. */
export function presentRawIds(raws: RawContracts): string[] {
  return [...raws.keys()].filter((id) => raws.get(id) !== null);
}

/**
 * Copies first, then the lock, then the removals.
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
  for (const directory of plan.directories) {
    await atomicWriteDirectory(root, directory.site, directory.files);
  }
  // The raw-byte sweeps go before the lock, unlike the document removals
  // below. The lock is the only memory of a raw-byte dest: written first, a
  // sweep that then failed would leave a directory nothing remembers. What
  // the sweep can lose is only what the gate confirmed this tool wrote.
  const swept = await removeEach(root, plan.sweeps);
  if (swept !== null) throw swept;
  await atomicWriteFile(root, plan.lock.site, plan.lock.content);
  const failed = await removeEach(root, plan.removals);
  if (failed !== null) throw failed;
}

/**
 * Removes every site, attempting each before reporting any, so one file that
 * cannot be cleared does not leave the rest standing behind it. The refusal
 * names the first failure, or null where all went.
 */
async function removeEach(
  root: string,
  sites: string[],
): Promise<ConfigError | null> {
  const failures: { site: string; cause: unknown }[] = [];
  for (const site of sites) {
    try {
      await assertPlainChain(root, site);
      // A path already gone is the state this asks for, not a failure: `force`
      // is what separates "there is nothing to remove" from "this could not be
      // removed", and only the second is worth stopping over.
      await fs.rm(`${root}/${site}`, { recursive: true, force: true });
    } catch (cause) {
      failures.push({ site, cause });
    }
  }
  if (failures.length === 0) return null;
  const [first] = failures;
  return new ConfigError(
    `cannot remove ${displayName(first.site)}: ${describeCause(first.cause)}`,
  );
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
  locations: Map<string, ContractLocation>,
): string[] {
  const violations: string[] = [];
  const dependentsOfId = dependentIndex(skills);
  for (const id of declaredIds(skills)) {
    if ((contracts.get(id) ?? null) !== null) continue;
    // A raw-byte contract is answered for by the placements module's own
    // closure check; it never had a single site to name here.
    if (!locations.has(id) && !contracts.has(id)) continue;
    // A contract fetched from elsewhere is not a closure gap when the cache is
    // empty: the tree does hold its text, in a repository the declaration
    // names, and what is missing is a fetch rather than a document. Reported
    // here, a clean checkout would fail for a state it is supposed to be in.
    if (locations.get(id)?.local === false) continue;
    const dependents = (dependentsOfId.get(id) ?? [])
      .map(displayName)
      .join(", ");
    const site = locations.get(id)?.site ?? contractPath(id);
    violations.push(
      `closure: ${id} is declared by ${dependents} but ${site} does not exist`,
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
 * A local contract whose canonical text is absent is passed over rather than
 * reported twice: it is already named as a closure gap, and the lock cannot be
 * judged against text the tree does not hold. A contract fetched from another
 * repository is not passed over, because nothing else speaks for it: the
 * closure check stays deliberately silent there — a clean checkout holds no
 * cache — and the tree an `add` leaves behind, with the mapping and the pin
 * written and no `gen` behind them, then passed every check while the copy the
 * skill declares had never been generated. What the lock records for a declared
 * contract is a fact about the lock, and it is decidable without the text.
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
  locations: Map<string, ContractLocation>,
): string[] {
  const violations: string[] = [];
  // The same contracts gen would rewrite the lock over, not the declared ones
  // alone. Walked over the declarations only, this judged a narrower set than
  // gen acts on: editing the canonical text of a contract nothing declares any
  // more left the tree reported as clean, and the next gen recorded the new
  // digest with nothing having said the text moved.
  for (const id of lockedOrDeclared(skills, resolutions)) {
    if (!locations.has(id)) continue;
    const contract = contracts.get(id) ?? null;
    const resolution = resolutions[id];
    // Only a declaration can be unresolved: it is the declaration that asks for
    // a pin, and an id reached through the lock has one by definition. Reported
    // for a contract nothing declares, every stray document under contracts/
    // would become a violation.
    if (resolution === undefined) {
      // Asked before the missing text is passed over, and that order is the
      // whole finding: a local contract with no text is already a closure gap,
      // while a remote one is a state the closure check keeps silent about, so
      // ordered the other way round the lock recording nothing for it was
      // reported by no check at all.
      if (contract === null && locations.get(id)?.local !== false) continue;
      violations.push(
        `unresolved: ${id} has no entry in ${LOCK_FILE}; run gen to record one`,
      );
      continue;
    }
    if (contract === null) continue;
    if (resolution.digest !== contract.digest) {
      const location = locations.get(id);
      const site = location?.site ?? contractPath(id);
      violations.push(
        `stale-lock: ${id} is recorded as ${resolution.digest} but ${site} ` +
          `is ${contract.digest}; ${staleLockRemedy(location)}`,
      );
    }
  }
  return violations;
}

/**
 * The way back out of a stale lock, which depends on who is authority over the
 * text.
 *
 * A local contract's text was edited by a person in this tree, so recording it
 * is the whole of the answer. A fetched contract's canonical text is in another
 * repository, and what stands here is a copy this tool throws away: told to run
 * gen, a person adopts whatever sits in that copy, and the cache is never
 * committed, so the bytes being adopted appear in no diff anybody reviews. The
 * fetch named instead rebuilds that copy from the commit the lock pins, judged
 * against the object ids the commit itself gives its files.
 *
 * The fetch is not named alone. The ordinary way into this state is an update
 * that moved the pin with no gen behind it yet, where the cache already holds
 * exactly what the commit does — a fetch changes nothing and the finding stands,
 * which would send the reader round the same loop for good.
 */
function staleLockRemedy(location: ContractLocation | undefined): string {
  if (location?.local === false) {
    return (
      `run fetch to rebuild the cache from the commit the lock pins, then ` +
      `gen to record what that commit holds`
    );
  }
  return "run gen to record the current text";
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
  placements: Placements;
  skills: SkillDeclaration[];
  sources: LockSources;
  declaration: Declaration;
}

export async function readTreeState(root: string): Promise<TreeState> {
  await assertTreeRoot(root);
  const { recordedSkills, resolutions, placements, sources } =
    await readLock(root);
  const skills = await readSkills(root, recordedSkills);
  return {
    resolutions,
    placements,
    skills,
    sources,
    declaration: await readDeclaration(root),
  };
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
 * Where every contract a run has to look at is read from, decided once.
 *
 * Asked through this one function by gen and by verify, because the two must
 * not disagree about which contracts a tree holds or where their text is. Each
 * building its own list is how they came apart: verify took the declared ids
 * while gen took the declared ids and the recorded ones, so a contract only the
 * lock named was rewritten by one command and never judged by the other.
 */
export async function locateTreeContracts(
  root: string,
  state: TreeState,
): Promise<Map<string, ContractLocation>> {
  return await locateContracts(
    root,
    state.declaration,
    state.sources,
    lockedOrDeclared(state.skills, state.resolutions),
  );
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
  locations: Map<string, ContractLocation>,
): Promise<Resolutions> {
  const resolutions = emptyRecord<Resolution>();
  for (const id of [...contracts.keys()].sort(compareStrings)) {
    const contract = contracts.get(id) ?? null;
    const site = locations.get(id)?.site ?? null;
    if (contract === null || site === null) continue;
    const resolution: Resolution = { digest: contract.digest };
    const conformance = await conformanceDigest(
      root,
      site,
      id,
      locations.get(id)?.local === true,
    );
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
 * Refuses a run whose declared remote contracts are not in the cache.
 *
 * A refusal, not a violation: the tree is not wrong, it is incomplete, and one
 * fetch completes it. What gen must not do is resolve the ref itself. That
 * would take up whatever the source repository holds today, with no line in
 * any diff saying a new version had been adopted — the moving target the lock
 * exists to pin down.
 *
 * Only the canonical text is asked about. The conformance tests beside it are
 * not, and the asymmetry is the decision rather than an oversight: the obvious
 * symmetric guard — refuse where the lock records a conformance digest and the
 * cache holds no tests — is a refusal with no way out of itself. The only
 * remedy it could name is a fetch, and a source that genuinely dropped its
 * tests upstream rebuilds a cache that still holds none, so the run would stop
 * for good over a state nothing in the tree can put right.
 *
 * Nor could such a guard tell the two apart. A revision directory standing at
 * its place means that revision was fetched whole, so "the source holds no
 * tests at this commit" and "someone deleted them out of the cache" leave the
 * same file system behind — and the second now costs a deliberate edit inside
 * a directory this tool documents as disposable, since a fetch stopped part
 * way no longer leaves a revision behind at all.
 *
 * The evidence leaving the lock is therefore reported rather than refused. The
 * run writes `retired: <id> conformance <digest>` for the digest that went, and
 * the lock's own diff loses the key beside it: the two lines a reviewer reads,
 * over a state one fetch restores.
 *
 * Two states reach this refusal and they take different ways out. Text absent
 * from a cache the lock already pins is put back by a fetch. Text whose source
 * the lock pins no commit for is not: a fetch reproduces a pin rather than
 * deciding one, and answers with a request for an update — two hops where one
 * would do, the first of them a command that cannot move this tree at all.
 *
 * A tree in both states is named the first way only. An update resolves every
 * pin and takes up what it holds, so the one command named there puts both
 * states right; naming a fetch beside it would send the reader to a command the
 * first already covers.
 */
function assertCacheHolds(
  skills: SkillDeclaration[],
  locations: Map<string, ContractLocation>,
  declaration: Declaration,
  sources: LockSources,
): void {
  const missing = declaredIds(skills).filter((id) => {
    const location = locations.get(id);
    return location !== undefined && !location.local && location.site === null;
  });
  if (missing.length === 0) return;
  const sourceOf = (id: string) => declaration.contracts[id]?.source;
  const named = (ids: string[]) =>
    ids.map((id) => `${id} (from ${sourceOf(id)})`).join(", ");
  const unpinned = missing.filter((id) => sources[sourceOf(id)] === undefined);
  if (unpinned.length > 0) {
    throw new ConfigError(
      `${LOCK_FILE} pins no commit for the source of ${named(unpinned)}; ` +
        `run update to resolve one`,
    );
  }
  throw new ConfigError(
    `the cache holds no text for ${named(missing)}; run fetch to put it back`,
  );
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
  const read = await readTreeState(root);
  // Asked before anything else this run does. What follows reads a cache
  // filled from the repository the lock names and rewrites the lock from what
  // it finds, so a run that carried on would distribute bytes the table
  // attributes to another repository and then leave a lock agreeing with the
  // table, with nothing anywhere saying the two had disagreed.
  assertPinnedRepositories(read.sources, read.declaration);
  const table = await reviseOrigins(root, read);
  const state = { ...read, declaration: table.declaration };
  const { resolutions: recorded, skills, sources } = state;
  const locations = await locateTreeContracts(root, state);
  const contracts = await readContracts(root, locations);
  const raws = await readRawContracts(
    root,
    state.declaration,
    lockedOrDeclared(skills, recorded),
  );
  const violations = [
    ...closureViolations(skills, contracts, locations),
    ...rawClosureViolations(skills, raws, state.declaration),
  ];
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  assertCacheHolds(skills, locations, state.declaration, sources);
  const derived = {
    ...(await deriveResolutions(root, contracts, locations)),
    ...(await deriveRawResolutions(raws)),
  };
  const plan = await planExpansion(
    root,
    skills,
    contracts,
    derived,
    sources,
    locations,
    state.declaration,
    raws,
    state.placements,
  );
  if (table.text !== null) {
    plan.files.push({
      site: DECLARATION_FILE,
      content: new TextEncoder().encode(table.text),
    });
  }
  await executePlan(root, plan);
  for (const line of table.report) out(line);
  for (const line of plan.report) out(line);
  for (const line of rewriteReport(recorded, derived)) out(line);
  return 0;
}

/**
 * The table of origins brought back in line with what the skills declare: a
 * line written for every declared contract this repository holds itself, and
 * the lines nothing declares any more taken out.
 *
 * Only a tree that already keeps a table is maintained. A repository using
 * nothing but its own contracts keeps none, and writing one for it would put a
 * file into every existing repository that nothing in it asked for — the table
 * is born with the first source registered, not with the first gen.
 *
 * Only the conventional position is searched, and only where no line exists
 * yet. A line already written is an adjudication, and a canonical text kept
 * anywhere else is a decision no derivation can make.
 *
 * The revised text is handed back rather than written, so it lands with every
 * other byte this run produces or with none of them.
 */
async function reviseOrigins(
  root: string,
  state: TreeState,
): Promise<{
  declaration: Declaration;
  text: string | null;
  report: string[];
}> {
  if (!(await isRegularFileOrAbsent(root, DECLARATION_FILE))) {
    return { declaration: state.declaration, text: null, report: [] };
  }
  const declared = new Set(declaredIds(state.skills));
  const report: string[] = [];
  let text = await readTextFile(
    `${root}/${DECLARATION_FILE}`,
    DECLARATION_FILE,
  );
  const before = text;
  // The lines nothing declares any more go first. A line kept for a withdrawn
  // contract holds its source open in the reader's mind and holds its text in
  // the cache after the last skill stopped asking for it.
  for (const id of Object.keys(state.declaration.contracts).sort(
    compareStrings,
  )) {
    if (declared.has(id)) continue;
    const pruned = withoutContractMapping(text, id);
    // A line the scribe could not reach is refused rather than reported. The
    // report is how the change to this table is read, so `unmapped` for an
    // entry still standing in the file sends a reviewer looking for a diff
    // nobody made. Passing over it in silence is no better: the entry would
    // stay for good, with every later run reaching this same point, doing
    // nothing and answering 0. Which shapes are out of reach is the scribe's
    // business — a flow-form entry, an indentation this tool never writes —
    // and all this can tell is that the edit did not happen.
    if (pruned === text) {
      throw new ConfigError(
        `${DECLARATION_FILE}: nothing declares ${id} any more, and its ` +
          `contracts.${id} entry is not written in a form this tool can take ` +
          `out; take the entry out by hand`,
      );
    }
    text = pruned;
    report.push(`unmapped: ${id}`);
  }
  for (const id of declaredIds(state.skills)) {
    if (state.declaration.contracts[id] !== undefined) continue;
    if (!(await isRegularFileOrAbsent(root, contractPath(id)))) continue;
    text = withContractMapping(text, id, LOCAL_SOURCE);
    report.push(`mapped: ${id} <- ${LOCAL_SOURCE}`);
  }
  if (text === before) {
    return { declaration: state.declaration, text: null, report: [] };
  }
  return { declaration: parseDeclaration(text), text, report };
}
