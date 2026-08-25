import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";
import {
  SKILLS_DIR,
  declaredIds,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import { MARKER_FILE } from "../contracts/raw.ts";
import type { Placements, Resolution } from "../contracts/lock-model.ts";
import type { Declaration, RawKind } from "../contracts/source-schema.ts";
import { displayName } from "../filesystem/walk.ts";
import { vendorHeader } from "./header.ts";
import {
  assertDestNotIgnored,
  driftDetail,
  expectedPlacements,
  observedDigest,
  observeDest,
  sameBytes,
  selectionRemovalDetail,
  type RawContracts,
} from "./placements.ts";

const LOCK_PREFIX = "vendor-lock.json";

export async function placementViolations(
  root: string,
  skills: SkillDeclaration[],
  declaration: Declaration,
  placements: Placements,
  resolutions: Record<string, Resolution>,
  raws: RawContracts,
): Promise<string[]> {
  const violations: string[] = [];
  const expected = expectedPlacements(skills, declaration);
  const disputed = new Set<string>();
  const rowless = new Set(
    declaredIds(skills).filter((id) => declaration.contracts[id] === undefined),
  );
  const skillNames = new Set([...expected.keys(), ...Object.keys(placements)]);
  for (const skill of [...skillNames].sort(compareStrings)) {
    const want = expected.get(skill) ?? new Map();
    const have = placements[skill] ?? emptyRecord();
    const keys = new Set([...want.keys(), ...Object.keys(have)]);
    for (const key of [...keys].sort(compareStrings)) {
      const site = displayName(`${SKILLS_DIR}/${skill}/${key}`);
      const w = want.get(key);
      const h = have[key];
      if (w === undefined && rowless.has(h.contract)) continue;
      if (w === undefined) {
        violations.push(
          `placement: ${LOCK_PREFIX} records ${site} for ${h.contract}, which no declaration places there any more; run gen to clear it`,
        );
        disputed.add(`${skill}\0${key}`);
      } else if (h === undefined) {
        violations.push(
          `placement: ${site} is declared for ${w.contract} but ${LOCK_PREFIX} records nothing there; run gen to place it`,
        );
      } else if (h.contract !== w.contract || h.src !== w.src) {
        violations.push(
          `placement: ${LOCK_PREFIX} records ${site} as ${h.contract} from ${h.src}, the table places ${w.contract} from ${w.src}; run gen`,
        );
        disputed.add(`${skill}\0${key}`);
      }
    }
  }
  for (const skill of Object.keys(placements).sort(compareStrings)) {
    for (const key of Object.keys(placements[skill]).sort(compareStrings)) {
      if (disputed.has(`${skill}\0${key}`)) continue;
      const placement = placements[skill][key];
      const kind: RawKind = key.endsWith("/") ? "directory" : "file";
      const dest = kind === "directory" ? key.slice(0, -1) : key;
      const site = `${SKILLS_DIR}/${skill}/${dest}`;
      await assertDestNotIgnored(root, site, kind);
      const observed = await observeDest(root, site);
      if (observed === null) {
        violations.push(`drift: ${displayName(site)} is missing`);
        continue;
      }
      if (observed.kind !== kind)
        throw new ConfigError(
          `${displayName(site)}: ${LOCK_PREFIX} records a ${kind} there, found a ${observed.kind}`,
        );
      const digest = await observedDigest(observed);
      const detail = driftDetail(
        raws,
        placement.contract,
        dest,
        kind,
        observed,
        site,
      );
      const removed = selectionRemovalDetail(
        raws,
        declaration,
        placement.contract,
        dest,
        kind,
        observed,
        site,
      );
      if (digest !== placement.digest) {
        violations.push(
          `drift: ${displayName(site)} holds files digesting to ${digest}, the lock pins ${placement.digest}${detail}`,
        );
      } else if (removed !== "") {
        violations.push(
          `drift: ${displayName(site)} differs from the currently selected canonical files${removed}; run gen to replace it`,
        );
      }
      if (kind === "directory") {
        const contract = resolutions[placement.contract];
        const marker = observed.entries.find(
          (entry) => entry.path === MARKER_FILE,
        );
        const wanted =
          contract === undefined
            ? null
            : new TextEncoder().encode(
                vendorHeader(placement.contract, contract.digest),
              );
        if (
          wanted !== null &&
          (marker === undefined || !sameBytes(marker.content, wanted))
        ) {
          violations.push(
            `drift: ${displayName(`${site}/${MARKER_FILE}`)} does not carry the marker generated for ${contract.digest}`,
          );
        }
      }
    }
  }
  return violations;
}
