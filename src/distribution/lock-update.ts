import { contractPath } from "../contracts/digest.ts";
import { conformanceDigest } from "../contracts/conformance.ts";
import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";
import {
  declaredIds,
  dependentIndex,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import { LOCK_FILE } from "../contracts/manifest.ts";
import type { Resolution, Resolutions } from "../contracts/lock-model.ts";
import type { ContractLocation } from "../contracts/sources.ts";
import { displayName } from "../filesystem/walk.ts";
import type { CanonicalContract } from "./contract-discovery.ts";
import { lockedOrDeclared } from "./tree-materials.ts";

export function closureViolations(
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  locations: Map<string, ContractLocation>,
): string[] {
  const violations: string[] = [];
  const dependentsOfId = dependentIndex(skills);
  for (const id of declaredIds(skills)) {
    if ((contracts.get(id) ?? null) !== null) continue;
    if (!locations.has(id) && !contracts.has(id)) continue;
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

export function lockViolations(
  skills: SkillDeclaration[],
  contracts: Map<string, CanonicalContract | null>,
  resolutions: Resolutions,
  locations: Map<string, ContractLocation>,
): string[] {
  const violations: string[] = [];
  for (const id of lockedOrDeclared(skills, resolutions)) {
    if (!locations.has(id)) continue;
    const contract = contracts.get(id) ?? null;
    const resolution = resolutions[id];
    if (resolution === undefined) {
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
        `stale-lock: ${id} is recorded as ${resolution.digest} but ${site} is ${contract.digest}; ${staleLockRemedy(location)}`,
      );
    }
  }
  return violations;
}

function staleLockRemedy(location: ContractLocation | undefined): string {
  return location?.local === false
    ? "run fetch to rebuild the cache from the commit the lock pins, then gen to record what that commit holds"
    : "run gen to record the current text";
}

export async function deriveResolutions(
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
export function rewriteReport(
  recorded: Resolutions,
  derived: Resolutions,
): string[] {
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
export function unusedReport(
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
