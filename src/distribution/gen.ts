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

import { ConfigError, type Sink } from "../errors.ts";
import { contractPath } from "../contracts/digest.ts";
import { compareStrings } from "../ordering.ts";
import { conformanceDigest } from "../contracts/conformance.ts";
import { isRegularFileOrAbsent, readTextFile } from "../filesystem/walk.ts";
import {
  declaredIds,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import { emptyRecord } from "../records.ts";
export { vendorHeader } from "./header.ts";
import { assertPinnedRepositories, LOCK_FILE } from "../contracts/manifest.ts";
import type {
  LockSources,
  Resolution,
  Resolutions,
} from "../contracts/lock-model.ts";
import {
  assertRawCacheHolds,
  deriveRawResolutions,
  rawClosureViolations,
} from "./raw-contracts.ts";
import { parseDeclaration } from "../contracts/source-schema.ts";
import {
  type ContractLocation,
  type Declaration,
  DECLARATION_FILE,
  LOCAL_SOURCE,
} from "../contracts/sources.ts";
import { planExpansion } from "./generation-plan.ts";
import { executePlan } from "./generation-write.ts";
import { closureViolations } from "./lock-update.ts";
import { classifyMissingRemoteContracts } from "./raw-contracts.ts";
import {
  withContractMapping,
  withoutContractMapping,
} from "../contracts/source-edit.ts";
import {
  prepareTreeMaterials,
  readTreeState,
  type TreeState,
} from "./tree-materials.ts";
import type { CanonicalContract } from "./contract-discovery.ts";

/**
 * The bytes of a vendored copy: the three facts the specification fixes, then
 * the canonical body.
 *
 * No source path and no time of generation appear. A path would make the copy
 * depend on where it came from, and a timestamp would make two runs over
 * unchanged input produce different files.
 */
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
/**
 * Removes every site, attempting each before reporting any, so one file that
 * cannot be cleared does not leave the rest standing behind it. The refusal
 * names the first failure, or null where all went.
 */
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
 * The resolutions the rewritten lock keeps that no skill declares any more.
 *
 * Withdrawing a declaration while the canonical text stays is not a
 * retirement — the text is still there, so the lock goes on resolving the id —
 * and every run after the withdrawal answered 0 over a resolution nothing
 * depends on, in silence. The only place that state was visible was what was
 * missing from the lock's own `dependencies`, and nobody reads a lock for
 * what is not in it.
 *
 * Reported rather than removed. What a withdrawal takes away is the copy, and
 * the copy is already gone; dropping the digest as well would decide that a
 * contract briefly out of use is a contract to be re-adopted from scratch when
 * it comes back. The exit code is untouched for the same reason: this is a
 * state to notice, not a tree that disagrees with itself.
 *
 * Reported every run rather than once, because it is a standing state and not
 * an event — the run that first reaches it is rarely the run somebody reads.
 *
 * A canonical text nothing has ever declared says nothing here, and that is
 * the point of reading `derived` rather than the contracts directory: a
 * resolution exists only for an id the lock or a declaration already named, so
 * the contracts a repository holds purely for other repositories to fetch —
 * the permanent state of a source repository — stay quiet.
 */
function unusedReport(
  skills: SkillDeclaration[],
  derived: Resolutions,
): string[] {
  const declared = new Set(declaredIds(skills));
  return Object.keys(derived)
    .sort(compareStrings)
    .filter((id) => !declared.has(id))
    .map(
      (id) =>
        `unused: ${id} (no skill declares it; its resolution stays in the lock)`,
    );
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
  const sourceOf = (id: string) => declaration.contracts[id]?.source;
  const { missing, unpinned } = classifyMissingRemoteContracts(
    declaredIds(skills),
    (id) => {
      const location = locations.get(id);
      return (
        location !== undefined && !location.local && location.site === null
      );
    },
    sourceOf,
    sources,
  );
  if (missing.length === 0) return;
  const named = (ids: string[]) =>
    ids.map((id) => `${id} (from ${sourceOf(id)})`).join(", ");
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
  const { locations, contracts, raws } = await prepareTreeMaterials(
    root,
    state,
  );
  const violations = [
    ...closureViolations(skills, contracts, locations),
    ...rawClosureViolations(skills, raws),
  ];
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  assertCacheHolds(skills, locations, state.declaration, sources);
  assertRawCacheHolds(skills, raws, state.declaration, sources);
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
  await executePlan(root, plan, out);
  for (const line of table.report) out(line);
  for (const line of plan.report) out(line);
  for (const line of rewriteReport(recorded, derived)) out(line);
  for (const line of unusedReport(skills, derived)) out(line);
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
    // A raw-byte row is a person's src → dest mapping, which no derivation
    // could write back. It stays until the person takes it out; the sweep
    // report is what tells them the row has nothing left to place.
    if (state.declaration.contracts[id].files !== undefined) continue;
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
