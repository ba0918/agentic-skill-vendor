import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";
import {
  SKILLS_DIR,
  declaredIds,
  type SkillDeclaration,
} from "../contracts/declaration.ts";
import {
  MARKER_FILE,
  placedPathOf,
  placementKeyOf,
  srcKeyOf,
} from "../contracts/raw.ts";
import { createDistributionIgnore } from "../contracts/distribution-ignore.ts";
import type { Placements, Resolution } from "../contracts/lock-model.ts";
import type { Declaration, RawKind } from "../contracts/sources.ts";
import { displayName } from "../filesystem/walk.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import { joinRelative } from "../filesystem/ignore.ts";
import { vendorHeader } from "./header.ts";
import {
  assertDestNotIgnored,
  firstDisagreement,
  observedDigest,
  observeDest,
  sameBytes,
  type ObservedDest,
} from "./placements.ts";
import { rawMappingsOf, type RawContracts } from "./raw-contracts.ts";

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

/**
 * The placements the declarations and the table say each skill should have:
 * dest → contract and src, without a digest, since the digest is the lock's.
 */
export function expectedPlacements(
  skills: SkillDeclaration[],
  declaration: Declaration,
): Map<string, Map<string, { contract: string; src: string }>> {
  const mappings = rawMappingsOf(declaration);
  const expected = new Map<
    string,
    Map<string, { contract: string; src: string }>
  >();
  for (const skill of skills) {
    const dests = new Map<string, { contract: string; src: string }>();
    for (const id of skill.contracts) {
      const rows = mappings.get(id);
      if (rows === undefined) continue;
      for (const mapping of rows) {
        dests.set(placementKeyOf(mapping), {
          contract: id,
          src: srcKeyOf(mapping),
        });
      }
    }
    if (dests.size > 0) expected.set(skill.name, dests);
  }
  return expected;
}

/**
 * The file a drifted dest disagrees on, where the canonical material is at
 * hand to say; empty otherwise, since the lock pins a digest and nothing more.
 */
export function driftDetail(
  raws: RawContracts,
  contract: string,
  dest: string,
  kind: RawKind,
  observed: ObservedDest,
  site: string,
): string {
  const material = raws
    .get(contract)
    ?.materials?.find(
      (m) => m.mapping.dest === dest && m.mapping.kind === kind,
    );
  if (material === undefined) return "";
  const planned: PlacedFile[] = material.files.map((file) => ({
    path: placedPathOf(material.mapping, file),
    content: file.content,
  }));
  const counted: ObservedDest = {
    ...observed,
    entries: observed.entries.filter(
      (entry) =>
        entry.path !== MARKER_FILE && !observed.ignored.has(entry.path),
    ),
  };
  const disagreement = firstDisagreement(counted, planned);
  if (disagreement === null) return "";
  const named = kind === "file" ? site : joinRelative(site, disagreement);
  return ` — ${displayName(named)} differs`;
}

export function selectionRemovalDetail(
  raws: RawContracts,
  declaration: Declaration,
  contract: string,
  dest: string,
  kind: RawKind,
  observed: ObservedDest,
  site: string,
): string {
  const material = raws
    .get(contract)
    ?.materials?.find(
      (candidate) =>
        candidate.mapping.dest === dest && candidate.mapping.kind === kind,
    );
  const origin = declaration.contracts[contract];
  if (material === undefined || origin === undefined || kind !== "directory") {
    return "";
  }
  const distribution = createDistributionIgnore(
    declaration.ignore,
    origin.ignore,
  );
  const removed = observed.entries.find(
    (entry) =>
      entry.path !== MARKER_FILE &&
      !observed.ignored.has(entry.path) &&
      distribution.excludes(entry.path),
  );
  if (removed === undefined) return "";
  const named = joinRelative(site, removed.path);
  return ` — ${displayName(named)} is no longer selected`;
}

/**
 * verify's two checks over raw-byte contracts: the lock's placements against
 * what the declarations and the table derive, and each recorded dest against
 * the digest recorded for it.
 *
 * A (skill, dest) the first check reports is left out of the second, so one
 * withdrawn skill is not named twice. The second check walks the lock's
 * placements, not the table's: what was written is what the lock remembers.
 */
