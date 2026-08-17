// accept.ts — the approval boundary.
//
// The only writer of resolutions, and therefore the point at which a change of
// contract text becomes approved. What protects deliberate adoption is not the
// command being awkward to run: it is that running it produces something
// reviewable.

import { ConfigError, type Sink } from "./errors.ts";
import {
  assertValidContractId,
  compareStrings,
  contractPath,
} from "./digest.ts";
import { conformanceDigest } from "./conformance.ts";
import { assertTreeRoot } from "./walk.ts";
import { declaredIds, dependentsOf, readSkills } from "./declaration.ts";
import { readLock, type Resolution, type Resolutions } from "./manifest.ts";
import {
  acceptanceViolations,
  executePlan,
  planExpansion,
  readContracts,
} from "./gen.ts";

interface AcceptanceRecord {
  id: string;
  previous: string | null;
  adopted: string;
}

/**
 * The only writer of resolutions, and therefore the boundary at which a change
 * of contract text becomes approved.
 *
 * What protects deliberate adoption is not the command being awkward to run: it
 * is that running it produces something reviewable. The skills it names are
 * read from the declarations this same run parsed, not from the lock: the lock
 * records the dependency graph as of the last write, and a skill that took the
 * contract up since then has to appear in the report of what this adoption
 * reaches. The two agree whenever the tree is clean, and where they disagree
 * the declarations are the newer answer.
 */
export async function commandAccept(
  root: string,
  ids: string[],
  out: Sink,
): Promise<number> {
  if (ids.length === 0) {
    throw new ConfigError("accept needs at least one contract id");
  }
  for (const [position, id] of ids.entries()) {
    assertValidContractId(id, "accept");
    if (ids.indexOf(id) !== position) {
      throw new ConfigError(`accept was given ${id} more than once`);
    }
  }

  await assertTreeRoot(root);
  const { recordedSkills, resolutions: previous } = await readLock(root);
  const skills = await readSkills(root, recordedSkills);
  const wanted = [...new Set([...ids, ...declaredIds(skills)])].sort(
    compareStrings,
  );
  const contracts = await readContracts(root, wanted);

  const resolutions: Resolutions = { ...previous };
  const records: AcceptanceRecord[] = [];
  for (const id of ids) {
    const contract = contracts.get(id) ?? null;
    if (contract === null) {
      throw new ConfigError(
        `cannot accept ${id}: ${contractPath(id)} does not exist`,
      );
    }
    const resolution: Resolution = { digest: contract.digest };
    const conformance = await conformanceDigest(root, id);
    if (conformance !== null) resolution.conformance = conformance;
    if (contract.version !== undefined) resolution.version = contract.version;
    records.push({
      id,
      previous: previous[id]?.digest ?? null,
      adopted: contract.digest,
    });
    resolutions[id] = resolution;
  }

  const violations = acceptanceViolations(skills, contracts, resolutions);
  if (violations.length > 0) {
    for (const violation of violations) out(violation);
    return 1;
  }
  await executePlan(
    root,
    await planExpansion(root, skills, contracts, resolutions),
  );

  for (const record of records) {
    const dependents = dependentsOf(skills, record.id);
    out(`accepted: ${record.id}`);
    out(`  old-digest: ${record.previous ?? "none (initial adoption)"}`);
    out(`  new-digest: ${record.adopted}`);
    out(
      `  dependents: ${
        dependents.length > 0 ? dependents.join(", ") : "(none)"
      }`,
    );
  }
  return 0;
}
