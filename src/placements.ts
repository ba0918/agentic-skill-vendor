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
import {
  displayName,
  kindAt,
  type PlacedFile,
  readBytes,
  walkFiles,
} from "./walk.ts";
import {
  ancestorDirectories,
  joinRelative,
  readIgnoreRules,
} from "./ignore.ts";
import { framedDigest } from "./raw.ts";
import type { RawKind } from "./sources.ts";

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
  /** The dests the run clears, as tree-relative sites; all gate-checked. */
  sweeps: string[];
  report: string[];
}

/** What stands at a dest right now: its kind and every file under it. */
interface ObservedDest {
  kind: RawKind;
  /** Every file, the ignored ones included; "" names a file dest itself. */
  entries: { path: string; content: Uint8Array }[];
  /** The paths the tree's ignore rules exclude, as a checkout would. */
  ignored: Set<string>;
}

/**
 * Reads what stands at a dest, or null where nothing does. A link at the
 * site or on the way to it is refused by the primitives underneath.
 */
async function observeDest(
  root: string,
  site: string,
): Promise<ObservedDest | null> {
  const info = await kindAt(root, site);
  if (info === null) return null;
  if (info.isFile()) {
    return {
      kind: "file",
      entries: [
        { path: "", content: await readBytes(`${root}/${site}`, site) },
      ],
      ignored: new Set(),
    };
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`${displayName(site)}: not a regular file`);
  }
  const found = await walkFiles(`${root}/${site}`, site);
  const rules = await readIgnoreRules(root, ancestorDirectories(site));
  const ignored = new Set(
    found.filter((path) => rules.excludes(joinRelative(site, path))),
  );
  const entries = [];
  for (const path of found) {
    entries.push({
      path,
      content: await readBytes(
        `${root}/${site}/${path}`,
        joinRelative(site, path),
      ),
    });
  }
  return { kind: "directory", entries, ignored };
}

/**
 * The placement digest of what stands at a dest: the ignored files and the
 * marker left out, a file dest named by its own name.
 */
async function observedDigest(
  observed: ObservedDest,
  site: string,
): Promise<string> {
  if (observed.kind === "file") {
    return await framedDigest([
      {
        path: site.slice(site.lastIndexOf("/") + 1),
        content: observed.entries[0].content,
      },
    ]);
  }
  return await framedDigest(
    observed.entries.filter(
      (entry) =>
        entry.path !== MARKER_FILE && !observed.ignored.has(entry.path),
    ),
  );
}

/** True when the dest holds exactly the files this run writes, nothing else. */
function holdsExactly(observed: ObservedDest, files: PlacedFile[]): boolean {
  if (observed.entries.length !== files.length) return false;
  const planned = new Map(files.map((file) => [file.path, file.content]));
  return observed.entries.every((entry) => {
    const content = planned.get(entry.path);
    return content !== undefined && sameBytes(content, entry.content);
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Every dest the declared raw-byte contracts land at, with the gate applied
 * in order: the dest is absent; or the lock records a placement at that path
 * for this skill and the dest still digests to it; or the dest already holds
 * exactly what the run writes, ignored files included — the recovery path,
 * which the run reports as a claim.
 */
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
      const materials = raws.get(id);
      if (materials === null || materials === undefined) continue;
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
        const claimed = await assertWritableDest(
          root,
          site,
          recorded[skill.name] ?? emptyRecord(),
          material.mapping,
          files,
        );
        if (claimed) report.push(`claimed: ${displayName(site)} (${id})`);
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
  const sweeps = await planSweep(root, recorded, dests, report);
  return { dests, placements, sweeps, report };
}

/**
 * The dests the lock remembers that this run does not write: each one of
 * them is cleared, and only when it still holds what the lock says it does.
 *
 * Compared as (skill, dest) pairs, never as dest strings alone — two skills
 * sharing a dest string must not excuse each other's sweep. A remembered dest
 * that nests with one this run writes is refused: whichever of copy and sweep
 * went first would destroy the other's work, so the table asks for two steps.
 * A dest already gone is the state the sweep asks for, reported as such so
 * the lock forgetting it leaves a line in the output.
 */
async function planSweep(
  root: string,
  recorded: Placements,
  dests: PlannedDest[],
  report: string[],
): Promise<string[]> {
  const written = new Set(dests.map((dest) => `${dest.skill}\0${dest.key}`));
  const sweeps: string[] = [];
  for (const skill of Object.keys(recorded).sort(compareStrings)) {
    for (const key of Object.keys(recorded[skill]).sort(compareStrings)) {
      if (written.has(`${skill}\0${key}`)) continue;
      const kind: RawKind = key.endsWith("/") ? "directory" : "file";
      const dest = kind === "directory" ? key.slice(0, -1) : key;
      const site = `${SKILLS_DIR}/${skill}/${dest}`;
      const placement = recorded[skill][key];
      for (const planned of dests) {
        if (planned.skill !== skill) continue;
        const other = planned.mapping.dest;
        if (other.startsWith(`${dest}/`) || dest.startsWith(`${other}/`)) {
          throw new ConfigError(
            `${displayName(site)} is recorded in the lock and nests with ` +
              `${displayName(planned.site)}, which this run writes; withdraw ` +
              `the declaration from every skill, run gen, then place the new ` +
              `dest`,
          );
        }
      }
      const observed = await observeDest(root, site);
      if (observed === null) {
        report.push(
          `cleared: ${displayName(site)}${kind === "directory" ? "/" : ""} ` +
            `(${placement.contract}; already absent)`,
        );
        continue;
      }
      if (observed.kind !== kind) {
        throw new ConfigError(
          `${displayName(site)}: the lock records a ${kind} there, found a ` +
            `${observed.kind}; it is not this tool's to clear`,
        );
      }
      const digest = await observedDigest(observed, site);
      if (digest !== placement.digest) {
        throw new ConfigError(
          `refusing to clear ${displayName(site)}: it no longer holds what ` +
            `the lock recorded this tool wrote there; delete it by hand if ` +
            `it is not yours`,
        );
      }
      sweeps.push(site);
      report.push(
        `cleared: ${displayName(site)}${kind === "directory" ? "/" : ""} ` +
          `(${placement.contract})`,
      );
    }
  }
  return sweeps;
}

/**
 * Refuses a dest the tree's own ignore rules would hide, and a file that
 * would be hidden once placed there.
 *
 * An ignored dest is one verify never sees and gen keeps writing — the two
 * commands disagreeing for good over a tree nobody changed. An ignored file
 * inside a dest is the same disagreement one level down: the placement digest
 * counts it, the dest's recomputation does not. Both are refused where the
 * rule is, rather than carried as a state.
 */
async function assertNotIgnored(
  root: string,
  site: string,
  kind: RawKind,
  files: PlacedFile[],
): Promise<void> {
  const rules = await readIgnoreRules(root, ancestorDirectories(site));
  if (rules.excludes(site, kind === "directory")) {
    throw new ConfigError(
      `${displayName(site)} is excluded by a .gitignore of this repository; ` +
        `a dest verify cannot see is not one gen may write — change the rule ` +
        `or the dest`,
    );
  }
  if (kind !== "directory") return;
  for (const file of files) {
    const path = joinRelative(site, file.path);
    if (rules.excludes(path)) {
      throw new ConfigError(
        `${displayName(path)} would be excluded by a .gitignore of this ` +
          `repository once placed; a distributed file verify cannot see is ` +
          `not one gen may write — change the rule or the dest`,
      );
    }
  }
}

/**
 * The gate. Returns true when the dest was taken over by condition 3 — a
 * claim the run reports — and refuses where no condition holds.
 */
async function assertWritableDest(
  root: string,
  site: string,
  recordedForSkill: Record<string, Placement>,
  mapping: RawMapping,
  files: PlacedFile[],
): Promise<boolean> {
  const observed = await observeDest(root, site);
  if (observed === null) return false;
  const remembered =
    recordedForSkill[`${mapping.dest}/`] ?? recordedForSkill[mapping.dest];
  const rememberedKind: RawKind | null =
    recordedForSkill[`${mapping.dest}/`] !== undefined
      ? "directory"
      : recordedForSkill[mapping.dest] !== undefined
        ? "file"
        : null;
  if (
    remembered !== undefined &&
    rememberedKind === observed.kind &&
    (await observedDigest(observed, site)) === remembered.digest
  ) {
    return false;
  }
  if (observed.kind === mapping.kind && holdsExactly(observed, files)) {
    return true;
  }
  throw new ConfigError(
    `refusing to write ${displayName(site)}: something stands there that ` +
      `the lock does not record as this tool's, and it is not what this run ` +
      `would write; move it aside or delete it by hand`,
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

/** True for an id the table or the lock knows as a raw-byte contract. */
export function isRawId(
  id: string,
  declaration: Declaration,
  resolutions: Record<string, Resolution>,
): boolean {
  return (
    declaration.contracts[id]?.files !== undefined ||
    resolutions[id]?.kind === "raw"
  );
}

/**
 * The placements the declarations and the table say each skill should have:
 * dest → contract and src, without a digest, since the digest is the lock's.
 */
function expectedPlacements(
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
 * verify's two checks over raw-byte contracts: the lock's placements against
 * what the declarations and the table derive, and each recorded dest against
 * the digest recorded for it.
 *
 * A (skill, dest) the first check reports is left out of the second, so one
 * withdrawn skill is not named twice. The second check walks the lock's
 * placements, not the table's: what was written is what the lock remembers.
 */
export async function placementViolations(
  root: string,
  skills: SkillDeclaration[],
  declaration: Declaration,
  placements: Placements,
  resolutions: Record<string, Resolution>,
): Promise<string[]> {
  const violations: string[] = [];
  const expected = expectedPlacements(skills, declaration);
  const disputed = new Set<string>();
  const skillNames = new Set([...expected.keys(), ...Object.keys(placements)]);
  for (const skill of [...skillNames].sort(compareStrings)) {
    const want = expected.get(skill) ?? new Map();
    const have = placements[skill] ?? emptyRecord();
    const keys = new Set([...want.keys(), ...Object.keys(have)]);
    for (const key of [...keys].sort(compareStrings)) {
      const site = displayName(`${SKILLS_DIR}/${skill}/${key}`);
      const w = want.get(key);
      const h = have[key];
      if (w === undefined) {
        violations.push(
          `placement: ${LOCK_PREFIX} records ${site} for ${h.contract}, which ` +
            `no declaration places there any more; run gen to clear it`,
        );
        disputed.add(`${skill}\0${key}`);
      } else if (h === undefined) {
        violations.push(
          `placement: ${site} is declared for ${w.contract} but ${LOCK_PREFIX} ` +
            `records nothing there; run gen to place it`,
        );
      } else if (h.contract !== w.contract || h.src !== w.src) {
        violations.push(
          `placement: ${LOCK_PREFIX} records ${site} as ${h.contract} from ` +
            `${h.src}, the table places ${w.contract} from ${w.src}; run gen`,
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
      const observed = await observeDest(root, site);
      if (observed === null) {
        violations.push(`drift: ${displayName(site)} is missing`);
        continue;
      }
      if (observed.kind !== kind) {
        throw new ConfigError(
          `${displayName(site)}: ${LOCK_PREFIX} records a ${kind} there, ` +
            `found a ${observed.kind}`,
        );
      }
      const digest = await observedDigest(observed, site);
      if (digest !== placement.digest) {
        violations.push(
          `drift: ${displayName(site)} holds files digesting to ${digest}, ` +
            `the lock pins ${placement.digest}`,
        );
      }
      if (kind === "directory") {
        const contract = resolutions[placement.contract];
        const marker = observed.entries.find((e) => e.path === MARKER_FILE);
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
            `drift: ${displayName(`${site}/${MARKER_FILE}`)} does not carry ` +
              `the marker generated for ${contract.digest}`,
          );
        }
      }
    }
  }
  return violations;
}

const LOCK_PREFIX = "vendor-lock.json";
