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
import { isRegularFileOrAbsent, readTextFile } from "../filesystem/walk.ts";
import {
  declaredIds,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
export { vendorHeader } from "./header.ts";
import { assertPinnedRepositories, LOCK_FILE } from "../contracts/manifest.ts";
import type { LockSources } from "../contracts/lock-model.ts";
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
import {
  closureViolations,
  deriveResolutions,
  rewriteReport,
  unusedReport,
} from "./lock-update.ts";
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
