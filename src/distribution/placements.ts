// placements.ts — distributing raw-byte contracts: what gen writes at each
// skill's dests, what it records about them, and what it may replace.
//
// A document contract lands in a directory the tool owns whole, so the tool
// can list it to learn what it wrote. A raw-byte contract lands where the
// table says, and the only memory of what was written there is the lock's
// placements. Everything in this module reads that memory before it touches a
// path, and writes it only after the path holds what the memory will say.

import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { createDistributionIgnore } from "../contracts/distribution-ignore.ts";
import type {
  LockSources,
  Placement,
  Placements,
  Resolution,
} from "../contracts/manifest.ts";
import { cacheRevisionDirOf } from "../contracts/cache.ts";
import { finalDestPath } from "../contracts/placement-ownership.ts";
import { LOCAL_SOURCE } from "../contracts/sources.ts";
import {
  basenameOf,
  MARKER_FILE,
  placedPathOf,
  placementDigest,
  placementKeyOf,
  rawContractDigest,
  type RawMaterial,
  srcKeyOf,
} from "../contracts/raw.ts";
import type { Declaration, RawMapping } from "../contracts/sources.ts";
import { readRawMaterials } from "./rawsource.ts";
import {
  declaredIds,
  dependentIndex,
  type SkillDeclaration,
  SKILLS_DIR,
} from "../contracts/declaration.ts";
import { emptyRecord } from "../records.ts";
import { vendorHeader } from "./header.ts";
import {
  assertPlainChain,
  displayName,
  isDirectoryOrAbsent,
  kindAt,
  type PlacedFile,
  readBytes,
  dirNameOf,
  walkFiles,
} from "../filesystem/walk.ts";
import {
  ancestorDirectories,
  type IgnoreRules,
  joinRelative,
  readIgnoreRules,
} from "../filesystem/ignore.ts";
import { framedDigest } from "../contracts/raw.ts";
import type { RawKind } from "../contracts/sources.ts";
import {
  derivePlacementMigrationComponents,
  type PlacementMigrationComponent,
  type RecordedDestination,
} from "../contracts/placement-ownership.ts";

/**
 * What one raw-byte contract's material is, and who answers for it.
 *
 * `materials` is null where the tree does not hold it: for a local contract a
 * closure gap, for a remote one a cache not yet fetched — a state a clean
 * checkout is in, which is why the two are told apart here.
 */
export interface RawReading {
  local: boolean;
  materials: RawMaterial[] | null;
  /** The first absent src in path order, where `materials` is null for that reason. */
  missing: string | null;
}

/** Every raw-byte contract a run has to look at, and what the tree holds for it. */
export type RawContracts = Map<string, RawReading>;

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
 * Reads the canonical side of every raw-byte contract among `ids`: from
 * this tree for a local one, from the cache at the pinned commit for a
 * remote one. A remote contract whose source the lock pins no commit for,
 * or whose revision the cache does not hold, reads as not held.
 *
 * The tree's own ignore rules apply to local material only. For fetched
 * material the source repository's rules already decided what the listing
 * held, and this tree's rules exclude the whole cache on purpose.
 */
export async function readRawContracts(
  root: string,
  declaration: Declaration,
  sources: LockSources,
  ids: string[],
): Promise<RawContracts> {
  const mappings = rawMappingsOf(declaration);
  const contracts: RawContracts = new Map();
  for (const id of ids) {
    const rows = mappings.get(id);
    if (rows === undefined) continue;
    const source = declaration.contracts[id].source;
    if (source === LOCAL_SOURCE) {
      const read = await readRawMaterials(
        root,
        id,
        rows,
        true,
        declaration.ignore,
        declaration.contracts[id].ignore,
      );
      contracts.set(
        id,
        Array.isArray(read)
          ? { local: true, materials: read, missing: null }
          : { local: true, materials: null, missing: read.missing },
      );
      continue;
    }
    const pinned = sources[source];
    if (pinned === undefined) {
      contracts.set(id, { local: false, materials: null, missing: null });
      continue;
    }
    const revision = cacheRevisionDirOf(source, pinned.revision);
    await assertPlainChain(root, revision);
    if (!(await isDirectoryOrAbsent(root, revision))) {
      contracts.set(id, { local: false, materials: null, missing: null });
      continue;
    }
    const inCache = rows.map((mapping) => ({
      ...mapping,
      src: `${revision}/${mapping.src}`,
    }));
    const read = await readRawMaterials(
      root,
      id,
      inCache,
      false,
      declaration.ignore,
      declaration.contracts[id].ignore,
    );
    contracts.set(id, {
      local: false,
      // The src the material is framed under is the source's own path, not
      // the cache site it was read from: the cache is where the bytes sit,
      // not what the contract is.
      materials: Array.isArray(read)
        ? read.map((material, index) => ({ ...material, mapping: rows[index] }))
        : null,
      missing: null,
    });
  }
  return contracts;
}

/** The declared raw-byte contracts whose src the tree does not hold. */
export function rawClosureViolations(
  skills: SkillDeclaration[],
  raws: RawContracts,
): string[] {
  const violations: string[] = [];
  const dependentsOfId = dependentIndex(skills);
  for (const id of declaredIds(skills)) {
    const reading = raws.get(id);
    // A remote contract's missing material is a fetch away, not a closure
    // gap: a clean checkout is in that state.
    if (reading === undefined || reading.materials !== null || !reading.local)
      continue;
    const dependents = (dependentsOfId.get(id) ?? [])
      .map(displayName)
      .join(", ");
    violations.push(
      `closure: ${id} is declared by ${dependents} but ${reading.missing} ` +
        `does not exist`,
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
    const materials = raws.get(id)?.materials ?? null;
    if (materials === null) continue;
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
  writes: {
    site: string;
    what: { files: PlacedFile[] } | { content: Uint8Array };
  }[];
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
  // The whole way down is refused for links, not the dest alone: a link at
  // `scripts/` would have every read, write and removal below it land
  // outside the skill, and the write primitives guard their own chain while
  // a removal and a digest would not.
  await assertPlainChain(root, site);
  const info = await kindAt(root, site);
  if (info === null) return null;
  if (info.isFile()) {
    return {
      kind: "file",
      entries: [
        {
          path: basenameOf(site),
          content: await readBytes(`${root}/${site}`, site),
        },
      ],
      ignored: new Set(),
    };
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`${displayName(site)}: not a regular file`);
  }
  const found = await walkFiles(`${root}/${site}`, site);
  const rules = await readIgnoreRules(root, destIgnoreLevels(site));
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
async function observedDigest(observed: ObservedDest): Promise<string> {
  return await framedDigest(
    observed.entries.filter(
      (entry) =>
        entry.path !== MARKER_FILE && !observed.ignored.has(entry.path),
    ),
  );
}

/**
 * The first file, in the dest's own order, that keeps it from holding exactly
 * what this run writes — one it holds that the run would not write, one whose
 * bytes differ, or one the run writes that it lacks — or null where none does.
 * The marker alone may be missing: a directory copied by hand before the tool
 * owned it has none, and claiming it is what the recovery path is for.
 */
function firstDisagreement(
  observed: ObservedDest,
  files: PlacedFile[],
): string | null {
  const planned = new Map(files.map((file) => [file.path, file.content]));
  const held = new Set(observed.entries.map((entry) => entry.path));
  for (const entry of observed.entries) {
    const content = planned.get(entry.path);
    if (content === undefined || !sameBytes(content, entry.content)) {
      return entry.path;
    }
  }
  for (const file of files) {
    if (!held.has(file.path) && file.path !== MARKER_FILE) return file.path;
  }
  return null;
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
  const destinationIdentity = (
    skill: string,
    contract: string,
    dest: string,
  ): string => `${skill}\0${contract}\0${dest}`;
  const finalByIdentity = new Map(
    dests.map((dest) => [
      destinationIdentity(
        dest.skill,
        dest.placement.contract,
        dest.mapping.dest,
      ),
      dest,
    ]),
  );
  const migratedOld = new Set<string>();
  const migratedFinal = new Set<string>();
  const writes: PlacementPlan["writes"] = [];
  for (const component of components) {
    for (const old of component.oldDestinations) {
      migratedOld.add(`${old.skill}\0${old.dest}`);
    }
    const members: PlannedDest[] = [];
    for (const final of component.finalDestinations) {
      const identity = destinationIdentity(
        final.skill,
        final.contract,
        final.dest,
      );
      const member = finalByIdentity.get(identity);
      if (member === undefined) {
        throw new ConfigError(
          `cannot plan migration destination ${displayName(final.dest)} in skill ${displayName(final.skill)}`,
        );
      }
      members.push(member);
      migratedFinal.add(identity);
    }
    writes.push(await planMigration(root, component, members, report));
  }
  for (const dest of dests) {
    if (
      migratedFinal.has(
        destinationIdentity(
          dest.skill,
          dest.placement.contract,
          dest.mapping.dest,
        ),
      )
    ) {
      continue;
    }
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

function relativeTo(outer: string, path: string): string {
  const root = finalDestPath(outer);
  const nested = finalDestPath(path);
  return nested === root ? "" : nested.slice(root.length + 1);
}

function compositeFiles(
  outer: string,
  destinations: PlannedDest[],
): PlacedFile[] {
  const files: PlacedFile[] = [];
  for (const destination of destinations) {
    const prefix = relativeTo(outer, destination.mapping.dest);
    if (destination.mapping.kind === "file") {
      files.push({ path: prefix, content: destination.files[0].content });
      continue;
    }
    for (const file of destination.files) {
      files.push({
        path: prefix === "" ? file.path : `${prefix}/${file.path}`,
        content: file.content,
      });
    }
  }
  return files;
}

function holdsExactComposite(
  observed: ObservedDest,
  kind: RawKind,
  files: PlacedFile[],
): boolean {
  if (observed.kind !== kind || observed.entries.length !== files.length) {
    return false;
  }
  if (kind === "file") {
    return (
      files.length === 1 &&
      files[0].path === "" &&
      sameBytes(observed.entries[0].content, files[0].content)
    );
  }
  const planned = new Map(files.map((file) => [file.path, file.content]));
  return observed.entries.every((entry) => {
    const content = planned.get(entry.path);
    return content !== undefined && sameBytes(entry.content, content);
  });
}

async function planMigration(
  root: string,
  component: PlacementMigrationComponent,
  destinations: PlannedDest[],
  report: string[],
): Promise<PlacementPlan["writes"][number]> {
  const outer = finalDestPath(component.outermostDest);
  const site = `${SKILLS_DIR}/${component.skill}/${outer}`;
  const files = compositeFiles(component.outermostDest, destinations);
  const finalAtOuter = destinations.find(
    (destination) =>
      finalDestPath(destination.mapping.dest) === outer &&
      destination.mapping.kind === "file",
  );
  const finalKind: RawKind = finalAtOuter === undefined ? "directory" : "file";
  const oldOwned = new Set<string>();
  const observedOuter = await observeDest(root, site);
  const alreadyComplete =
    observedOuter !== null &&
    holdsExactComposite(observedOuter, finalKind, files);

  if (observedOuter === null || alreadyComplete) {
    for (const old of component.oldDestinations) {
      const oldDest = finalDestPath(old.dest);
      const oldSite = `${SKILLS_DIR}/${old.skill}/${oldDest}`;
      const oldKind: RawKind = old.dest.endsWith("/") ? "directory" : "file";
      report.push(
        `cleared: ${displayName(oldSite)}${oldKind === "directory" ? "/" : ""} (${old.placement.contract}${observedOuter === null ? "; already absent" : ""})`,
      );
    }
    if (alreadyComplete) {
      for (const destination of destinations) {
        const suffix = destination.mapping.kind === "directory" ? "/" : "";
        report.push(
          `claimed: ${displayName(destination.site)}${suffix} (${destination.placement.contract})`,
        );
      }
    }
    return finalAtOuter === undefined
      ? { site, what: { files } }
      : { site, what: { content: finalAtOuter.files[0].content } };
  }

  for (const old of component.oldDestinations) {
    const oldDest = finalDestPath(old.dest);
    const oldSite = `${SKILLS_DIR}/${old.skill}/${oldDest}`;
    const oldKind: RawKind = old.dest.endsWith("/") ? "directory" : "file";
    await assertDestNotIgnored(root, oldSite, oldKind);
    const observed = await observeDest(root, oldSite);
    if (observed === null || observed.kind !== oldKind) {
      throw new ConfigError(
        `${displayName(oldSite)} no longer has the ${oldKind} placement recorded by the lock`,
      );
    }
    if ((await observedDigest(observed)) !== old.placement.digest) {
      const relative = relativeTo(component.outermostDest, old.dest);
      const counted = {
        ...observed,
        entries: observed.entries.filter(
          (entry) =>
            entry.path !== MARKER_FILE && !observed.ignored.has(entry.path),
        ),
      };
      const expected = files
        .filter(
          (file) =>
            relative === "" ||
            file.path.startsWith(`${relative}/`) ||
            file.path === relative,
        )
        .map((file) => ({
          path:
            oldKind === "file"
              ? basenameOf(oldDest)
              : relative === ""
                ? file.path
                : file.path.slice(relative.length + 1),
          content: file.content,
        }));
      const disagreement = firstDisagreement(counted, expected);
      const named =
        disagreement === null || oldKind === "file"
          ? oldSite
          : joinRelative(oldSite, disagreement);
      throw new ConfigError(
        `refusing to migrate ${displayName(oldSite)}: ${displayName(named)} differs from the placement recorded by the lock`,
      );
    }
    const prefix = relativeTo(component.outermostDest, old.dest);
    for (const entry of observed.entries) {
      oldOwned.add(
        oldKind === "file"
          ? prefix
          : prefix === ""
            ? entry.path
            : `${prefix}/${entry.path}`,
      );
    }
    report.push(
      `cleared: ${displayName(oldSite)}${oldKind === "directory" ? "/" : ""} (${old.placement.contract})`,
    );
  }

  for (const entry of observedOuter.entries) {
    const path = observedOuter.kind === "file" ? "" : entry.path;
    if (oldOwned.has(path)) continue;
    const named = path === "" ? site : joinRelative(site, path);
    throw new ConfigError(
      `refusing to write ${displayName(site)}: ${displayName(named)} is not owned by an old placement or written by this run`,
    );
  }

  return finalAtOuter === undefined
    ? { site, what: { files } }
    : { site, what: { content: finalAtOuter.files[0].content } };
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
  migrated: Set<string>,
): Promise<string[]> {
  // Sameness is the path, not the key: a dest switching kind keeps its path
  // under a new key, and the gate already let the write replace it in place.
  // Sweeping the old key would clear the dest this run just wrote.
  const written = new Set(
    dests.map((dest) => `${dest.skill}\0${dest.mapping.dest}`),
  );
  const sweeps: string[] = [];
  for (const skill of Object.keys(recorded).sort(compareStrings)) {
    for (const key of Object.keys(recorded[skill]).sort(compareStrings)) {
      if (migrated.has(`${skill}\0${key}`)) continue;
      const kind: RawKind = key.endsWith("/") ? "directory" : "file";
      const dest = kind === "directory" ? key.slice(0, -1) : key;
      if (written.has(`${skill}\0${dest}`)) continue;
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
      await assertDestNotIgnored(root, site, kind);
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
      const digest = await observedDigest(observed);
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
 * The .gitignore levels that have a say over a dest: the root down to the
 * dest's parent. A .gitignore inside the dest is not one of them — the tool
 * never distributes one there, so one standing there is a foreign file, and
 * reading it would let that file hide itself and anything beside it.
 */
function destIgnoreLevels(site: string): string[] {
  return ancestorDirectories(dirNameOf(site));
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
  const rules = await assertDestNotIgnored(root, site, kind);
  if (kind !== "directory") return;
  for (const file of files) {
    const path = joinRelative(site, file.path);
    const by = rules.exclusionOf(path);
    if (by !== null) {
      throw new ConfigError(
        `${displayName(path)} would be excluded by ${displayName(by)} once ` +
          `placed; a distributed file verify cannot see is not one gen may ` +
          `write — change the rule or the dest`,
      );
    }
  }
}

/**
 * Refuses a dest the tree's own ignore rules would hide, for gen and verify
 * alike, and hands back the rules for the caller's own further questions.
 */
async function assertDestNotIgnored(
  root: string,
  site: string,
  kind: RawKind,
): Promise<IgnoreRules> {
  const rules = await readIgnoreRules(root, destIgnoreLevels(site));
  const by = rules.exclusionOf(site, kind === "directory");
  if (by !== null) {
    throw new ConfigError(
      `${displayName(site)} is excluded by ${displayName(by)}; a dest verify ` +
        `cannot see is not one gen may write — change the rule or the dest`,
    );
  }
  return rules;
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
    (await observedDigest(observed)) === remembered.digest
  ) {
    return false;
  }
  if (observed.kind !== mapping.kind) {
    throw new ConfigError(
      `refusing to write ${displayName(site)}: a ${observed.kind} stands ` +
        `there that the lock does not record as this tool's, and this run ` +
        `writes a ${mapping.kind}; move it aside or delete it by hand`,
    );
  }
  const disagreement = firstDisagreement(observed, files);
  if (disagreement === null) return true;
  const named =
    mapping.kind === "file" ? site : joinRelative(site, disagreement);
  throw new ConfigError(
    `refusing to write ${displayName(site)}: something stands there that ` +
      `the lock does not record as this tool's, and it is not what this run ` +
      `would write — ${displayName(named)} differs or is not this run's to ` +
      `write; move it aside or delete it by hand`,
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
 * The file a drifted dest disagrees on, where the canonical material is at
 * hand to say; empty otherwise, since the lock pins a digest and nothing more.
 */
function driftDetail(
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

function selectionRemovalDetail(
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
  // A declared id whose table row is gone is already a closure gap; its
  // placements are left to that report rather than named a second time.
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
      if (w === undefined && rowless.has(h.contract)) {
        continue;
      }
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
      await assertDestNotIgnored(root, site, kind);
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
          `drift: ${displayName(site)} holds files digesting to ${digest}, ` +
            `the lock pins ${placement.digest}` +
            detail,
        );
      } else if (removed !== "") {
        violations.push(
          `drift: ${displayName(site)} differs from the currently selected ` +
            `canonical files${removed}; run gen to replace it`,
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

/**
 * Refuses a table row whose kind disagrees with what the lock remembers the
 * contract as. Both directions: a raw-byte row over a document resolution,
 * and a document row over a raw-byte one. Silently taken, one kind's copies
 * would be left behind by the other kind's sweep. An id with no row is not
 * judged — that state is a closure gap, or a retirement.
 */
export function assertKindsAgree(
  declaration: Declaration,
  resolutions: Record<string, Resolution>,
): void {
  for (const id of Object.keys(declaration.contracts).sort(compareStrings)) {
    const resolution = resolutions[id];
    if (resolution === undefined) continue;
    const rowIsRaw = declaration.contracts[id].files !== undefined;
    const lockIsRaw = resolution.kind === "raw";
    if (rowIsRaw === lockIsRaw) continue;
    throw new ConfigError(
      `${id} is ${rowIsRaw ? "a raw-byte" : "a document"} contract in ` +
        `vendor-manifest.yaml but the lock resolves it as ` +
        `${lockIsRaw ? "raw-byte" : "a document"}; a contract cannot change ` +
        `kind in place — withdraw it from every skill, run gen, take the row ` +
        `out, run gen again, then write the new row`,
    );
  }
}

/**
 * What the lock records for each raw-byte contract this run read, against
 * what its src digests to now: the raw-byte half of the
 * lock-versus-canonical check. A contract the lock says nothing about is
 * unresolved; one it records another digest for is a stale lock.
 */
export function rawLockViolations(
  raws: RawContracts,
  recorded: Record<string, Resolution>,
  derived: Record<string, Resolution>,
): string[] {
  const violations: string[] = [];
  for (const id of [...raws.keys()].sort(compareStrings)) {
    const resolution = recorded[id];
    if (resolution === undefined) {
      violations.push(
        `unresolved: ${id} has no entry in vendor-lock.json; run gen to record one`,
      );
      continue;
    }
    const now = derived[id];
    // Material not held — a remote contract with no cache — is not compared:
    // the lock cannot be judged against files the tree does not have.
    if (now === undefined) continue;
    if (resolution.digest !== now.digest) {
      violations.push(
        `stale-lock: ${id} is recorded as ${resolution.digest} but its files ` +
          `digest to ${now.digest}; run gen to record the current files`,
      );
    }
  }
  return violations;
}

/**
 * Refuses a gen whose declared remote raw-byte contracts are not in the
 * cache, naming the one command that completes the tree — a fetch where the
 * lock pins a commit, an update where it pins none. The document-contract
 * refusal says the same about its own ids; the two are not folded because
 * the material they ask about is read by different modules.
 */
export function assertRawCacheHolds(
  skills: SkillDeclaration[],
  raws: RawContracts,
  declaration: Declaration,
  sources: LockSources,
): void {
  const missing = declaredIds(skills).filter((id) => {
    const reading = raws.get(id);
    return (
      reading !== undefined && !reading.local && reading.materials === null
    );
  });
  if (missing.length === 0) return;
  const sourceOf = (id: string) => declaration.contracts[id].source;
  const named = (ids: string[]) =>
    ids.map((id) => `${id} (from ${sourceOf(id)})`).join(", ");
  const unpinned = missing.filter((id) => sources[sourceOf(id)] === undefined);
  if (unpinned.length > 0) {
    throw new ConfigError(
      `vendor-lock.json pins no commit for the source of ${named(unpinned)}; ` +
        `run update to resolve one`,
    );
  }
  throw new ConfigError(
    `the cache holds no files for ${named(missing)}; run fetch to put them back`,
  );
}

/** The raw-byte contracts the lock keeps a resolution for: local ones the tree holds, remote ones by their row. */
export function presentRawIds(raws: RawContracts): string[] {
  return [...raws.keys()].filter((id) => {
    const reading = raws.get(id) as RawReading;
    return !reading.local || reading.materials !== null;
  });
}

/** A document contract's conformance position inside the source that owns it. */
export interface ConformancePosition {
  source: string;
  directory: string;
}

/**
 * Refuses a raw-byte src that stands at, under or over the conformance
 * position of a document contract in the same source. Conformance tests are
 * collected by path prefix with no notion of which contract a file belongs
 * to, so a src over that position would distribute the tests and one under it
 * would be pinned as tests.
 */
export function assertSrcsClearOfConformance(
  declaration: Declaration,
  conformancePositions: Map<string, ConformancePosition>,
): void {
  for (const id of Object.keys(declaration.contracts).sort(compareStrings)) {
    const source = declaration.contracts[id].source;
    for (const mapping of declaration.contracts[id].files ?? []) {
      for (const [other, position] of conformancePositions) {
        if (source !== position.source) continue;
        const { directory } = position;
        if (
          mapping.src === directory ||
          mapping.src.startsWith(`${directory}/`) ||
          directory.startsWith(`${mapping.src}/`)
        ) {
          throw new ConfigError(
            `vendor-manifest.yaml: contracts.${id}.files names the src ` +
              `${JSON.stringify(srcKeyOf(mapping))}, which is at, under or ` +
              `over ${directory}, the conformance position of ${other}; ` +
              `tests are collected by prefix, so the two would be confused`,
          );
        }
      }
    }
  }
}
