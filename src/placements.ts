// placements.ts — distributing raw-byte contracts: what gen writes at each
// skill's dests, what it records about them, and what it may replace.
//
// A document contract lands in a directory the tool owns whole, so the tool
// can list it to learn what it wrote. A raw-byte contract lands where the
// table says, and the only memory of what was written there is the lock's
// placements. Everything in this module reads that memory before it touches a
// path, and writes it only after the path holds what the memory will say.

import { ConfigError } from "./errors.ts";
import { compareStrings } from "./digest.ts";
import type { Placement, Placements, Resolution } from "./manifest.ts";
import {
  MARKER_FILE,
  placedPathOf,
  placementDigest,
  placementKeyOf,
  rawContractDigest,
  type RawMaterial,
  srcKeyOf,
} from "./raw.ts";
import type { Declaration, RawMapping } from "./sources.ts";
import { readRawMaterials } from "./rawsource.ts";
import {
  declaredIds,
  dependentIndex,
  type SkillDeclaration,
  SKILLS_DIR,
} from "./declaration.ts";
import { emptyRecord } from "./records.ts";
import { vendorHeader } from "./header.ts";
import { displayName, kindAt, type PlacedFile } from "./walk.ts";

/** Every raw-byte contract a run has to look at, and what the tree holds for it. */
export type RawContracts = Map<string, RawMaterial[] | null>;

/** The ids the table declares as raw-byte contracts. */
export function rawMappingsOf(
  declaration: Declaration,
): Map<string, RawMapping[]> {
  const raw = new Map<string, RawMapping[]>();
  for (const id of Object.keys(declaration.contracts)) {
    const files = declaration.contracts[id].files;
    if (files !== undefined) raw.set(id, files);
  }
  return raw;
}

/**
 * Reads the canonical side of every raw-byte contract among `ids`.
 *
 * Only this repository's own material is read here: a remote raw-byte
 * contract is a later concern, and until then a row naming another source is
 * refused rather than silently read as absent.
 */
export async function readRawContracts(
  root: string,
  declaration: Declaration,
  ids: string[],
): Promise<RawContracts> {
  const mappings = rawMappingsOf(declaration);
  const contracts: RawContracts = new Map();
  for (const id of ids) {
    const rows = mappings.get(id);
    if (rows === undefined) continue;
    if (declaration.contracts[id].source !== "local") {
      throw new ConfigError(
        `${id}: a raw-byte contract from another repository is not ` +
          `supported yet`,
      );
    }
    contracts.set(id, await readRawMaterials(root, id, rows, true));
  }
  return contracts;
}

/** The declared raw-byte contracts whose src the tree does not hold. */
export function rawClosureViolations(
  skills: SkillDeclaration[],
  raws: RawContracts,
  declaration: Declaration,
): string[] {
  const violations: string[] = [];
  const dependentsOfId = dependentIndex(skills);
  for (const id of declaredIds(skills)) {
    if (!raws.has(id) || raws.get(id) !== null) continue;
    const dependents = (dependentsOfId.get(id) ?? [])
      .map(displayName)
      .join(", ");
    const first = declaration.contracts[id].files?.[0];
    violations.push(
      `closure: ${id} is declared by ${dependents} but ${srcKeyOf(
        first as RawMapping,
      )} does not exist`,
    );
  }
  return violations;
}

/** The resolution each raw-byte contract the tree holds renders to. */
export async function deriveRawResolutions(
  raws: RawContracts,
): Promise<Record<string, Resolution>> {
  const resolutions = emptyRecord<Resolution>();
  for (const id of [...raws.keys()].sort(compareStrings)) {
    const materials = raws.get(id);
    if (materials === null || materials === undefined) continue;
    resolutions[id] = {
      digest: await rawContractDigest(materials),
      kind: "raw",
    };
  }
  return resolutions;
}

/** One dest this run writes: where, as what, and what the lock will record. */
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
  placements: Placements;
}

/**
 * Every dest the declared raw-byte contracts land at, with the gate applied:
 * a dest is written only where nothing stands yet.
 */
export async function planPlacements(
  root: string,
  skills: SkillDeclaration[],
  raws: RawContracts,
  resolutions: Record<string, Resolution>,
): Promise<PlacementPlan> {
  const dests: PlannedDest[] = [];
  const placements: Placements = emptyRecord();
  for (const skill of skills) {
    for (const id of [...skill.contracts].sort(compareStrings)) {
      const materials = raws.get(id);
      if (materials === null || materials === undefined) continue;
      for (const material of materials) {
        const key = placementKeyOf(material.mapping);
        const site = `${SKILLS_DIR}/${skill.name}/${material.mapping.dest}`;
        await assertWritableDest(root, site);
        const files = placedFilesOf(material, id, resolutions[id].digest);
        const placement: Placement = {
          contract: id,
          src: srcKeyOf(material.mapping),
          digest: await placementDigest(material),
        };
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
  return { dests, placements };
}

/** Gate condition 1: the dest holds nothing. */
async function assertWritableDest(root: string, site: string): Promise<void> {
  if ((await kindAt(root, site)) === null) return;
  throw new ConfigError(
    `refusing to write ${displayName(site)}: something stands there that ` +
      `the lock does not record as this tool's`,
  );
}

/** The files a dest holds, the marker included for a directory dest. */
function placedFilesOf(
  material: RawMaterial,
  id: string,
  contractDigest: string,
): PlacedFile[] {
  const files: PlacedFile[] = material.files.map((file) => ({
    path: placedPathOf(material.mapping, file),
    content: file.content,
  }));
  if (material.mapping.kind === "directory") {
    files.push({
      path: MARKER_FILE,
      content: new TextEncoder().encode(vendorHeader(id, contractDigest)),
    });
  }
  return files;
}
