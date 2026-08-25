import { contractPath } from "../contracts/digest.ts";
import {
  declaredIds,
  dependentIndex,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import { LOCK_FILE } from "../contracts/manifest.ts";
import type { Resolutions } from "../contracts/lock-model.ts";
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
