import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";
import { SKILLS_DIR, type SkillDeclaration } from "../contracts/declaration.ts";
import type {
  Placement,
  Placements,
  Resolution,
} from "../contracts/lock-model.ts";
import {
  derivePlacementMigrationComponents,
  type RecordedDestination,
} from "../contracts/placement-ownership.ts";
import { placementDigest, placementKeyOf, srcKeyOf } from "../contracts/raw.ts";
import { displayName } from "../filesystem/walk.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import type { RawMapping } from "../contracts/sources.ts";
import {
  assertNotIgnored,
  assertWritableDest,
  placedFilesOf,
  planMigration,
  planSweep,
  type RawContracts,
} from "./placements.ts";

export interface PlannedDest {
  skill: string;
  key: string;
  site: string;
  mapping: RawMapping;
  files: PlacedFile[];
  placement: Placement;
}

export interface PlacementPlan {
  dests: PlannedDest[];
  writes: {
    site: string;
    what: { files: PlacedFile[] } | { content: Uint8Array };
  }[];
  placements: Placements;
  sweeps: string[];
  report: string[];
}

export async function planPlacements(
  root: string,
  skills: SkillDeclaration[],
  raws: RawContracts,
  resolutions: Record<string, Resolution>,
  recorded: Placements,
): Promise<PlacementPlan> {
  const dests: PlannedDest[] = [];
  const placements: Placements = emptyRecord();
  const report: string[] = [];
  for (const skill of skills) {
    for (const id of [...skill.contracts].sort(compareStrings)) {
      const materials = raws.get(id)?.materials ?? null;
      if (materials === null) continue;
      for (const material of materials) {
        const key = placementKeyOf(material.mapping);
        const site = `${SKILLS_DIR}/${skill.name}/${material.mapping.dest}`;
        const files = placedFilesOf(material, id, resolutions[id].digest);
        const placement: Placement = {
          contract: id,
          src: srcKeyOf(material.mapping),
          digest: await placementDigest(material),
        };
        await assertNotIgnored(root, site, material.mapping.kind, files);
        dests.push({
          skill: skill.name,
          key,
          site,
          mapping: material.mapping,
          files,
          placement,
        });
        placements[skill.name] ??= emptyRecord();
        placements[skill.name][key] = placement;
      }
    }
  }
  const finalPaths = new Set(
    dests.map((dest) => `${dest.skill}\0${dest.mapping.dest}`),
  );
  const oldDestinations: RecordedDestination[] = [];
  for (const skill of Object.keys(recorded).sort(compareStrings)) {
    for (const key of Object.keys(recorded[skill]).sort(compareStrings)) {
      const dest = key.endsWith("/") ? key.slice(0, -1) : key;
      if (finalPaths.has(`${skill}\0${dest}`)) continue;
      oldDestinations.push({
        skill,
        dest: key,
        placement: recorded[skill][key],
      });
    }
  }
  const components = derivePlacementMigrationComponents(
    oldDestinations,
    dests.map((dest) => ({
      skill: dest.skill,
      contract: dest.placement.contract,
      dest: dest.mapping.dest,
    })),
  );
  const identity = (skill: string, contract: string, dest: string) =>
    `${skill}\0${contract}\0${dest}`;
  const finalByIdentity = new Map(
    dests.map((dest) => [
      identity(dest.skill, dest.placement.contract, dest.mapping.dest),
      dest,
    ]),
  );
  const migratedOld = new Set<string>();
  const migratedFinal = new Set<string>();
  const writes: PlacementPlan["writes"] = [];
  for (const component of components) {
    for (const old of component.oldDestinations)
      migratedOld.add(`${old.skill}\0${old.dest}`);
    const members: PlannedDest[] = [];
    for (const final of component.finalDestinations) {
      const key = identity(final.skill, final.contract, final.dest);
      const member = finalByIdentity.get(key);
      if (member === undefined)
        throw new ConfigError(
          `cannot plan migration destination ${displayName(final.dest)} in skill ${displayName(final.skill)}`,
        );
      members.push(member);
      migratedFinal.add(key);
    }
    writes.push(await planMigration(root, component, members, report));
  }
  for (const dest of dests) {
    if (
      migratedFinal.has(
        identity(dest.skill, dest.placement.contract, dest.mapping.dest),
      )
    )
      continue;
    const claimed = await assertWritableDest(
      root,
      dest.site,
      recorded[dest.skill] ?? emptyRecord(),
      dest.mapping,
      dest.files,
    );
    if (claimed) {
      const suffix = dest.mapping.kind === "directory" ? "/" : "";
      report.push(
        `claimed: ${displayName(dest.site)}${suffix} (${dest.placement.contract})`,
      );
    }
    writes.push({
      site: dest.site,
      what:
        dest.mapping.kind === "directory"
          ? { files: dest.files }
          : { content: dest.files[0].content },
    });
  }
  const sweeps = await planSweep(root, recorded, dests, report, migratedOld);
  return { dests, writes, placements, sweeps, report };
}
