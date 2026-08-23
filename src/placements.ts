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
import type {
  LockSources,
  Placement,
  Placements,
  Resolution,
} from "./manifest.ts";
import { cacheRevisionDirOf } from "./cache.ts";
import { LOCAL_SOURCE } from "./sources.ts";
import {
  basenameOf,
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
  assertPlainChain,
  displayName,
  isDirectoryOrAbsent,
  kindAt,
  type PlacedFile,
  readBytes,
  dirNameOf,
  walkFiles,
} from "./walk.ts";
import {
  ancestorDirectories,
  joinRelative,
  readIgnoreRules,
} from "./ignore.ts";
import { framedDigest } from "./raw.ts";
import type { RawKind } from "./sources.ts";

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
      contracts.set(id, {
        local: true,
        materials: await readRawMaterials(root, id, rows, true),
      });
      continue;
    }
    const pinned = sources[source];
    if (pinned === undefined) {
      contracts.set(id, { local: false, materials: null });
      continue;
    }
    const revision = cacheRevisionDirOf(source, pinned.revision);
    await assertPlainChain(root, revision);
    if (!(await isDirectoryOrAbsent(root, revision))) {
      contracts.set(id, { local: false, materials: null });
      continue;
    }
    const inCache = rows.map((mapping) => ({
      ...mapping,
      src: `${revision}/${mapping.src}`,
    }));
    const materials = await readRawMaterials(root, id, inCache, false);
    contracts.set(id, {
      local: false,
      // The src the material is framed under is the source's own path, not
      // the cache site it was read from: the cache is where the bytes sit,
      // not what the contract is.
      materials:
        materials === null
          ? null
          : materials.map((material, index) => ({
              ...material,
              mapping: rows[index],
            })),
    });
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
    const reading = raws.get(id);
    // A remote contract's missing material is a fetch away, not a closure
    // gap: a clean checkout is in that state.
    if (reading === undefined || reading.materials !== null || !reading.local)
      continue;
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
 * True when the dest holds exactly the files this run writes, nothing else.
 * The marker alone may be missing: a directory copied by hand before the tool
 * owned it has none, and claiming it is what the recovery path is for.
 */
function holdsExactly(observed: ObservedDest, files: PlacedFile[]): boolean {
  const planned = new Map(files.map((file) => [file.path, file.content]));
  const held = new Set(observed.entries.map((entry) => entry.path));
  return (
    observed.entries.every((entry) => {
      const content = planned.get(entry.path);
      return content !== undefined && sameBytes(content, entry.content);
    }) &&
    files.every((file) => held.has(file.path) || file.path === MARKER_FILE)
  );
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
  // Sameness is the path, not the key: a dest switching kind keeps its path
  // under a new key, and the gate already let the write replace it in place.
  // Sweeping the old key would clear the dest this run just wrote.
  const written = new Set(
    dests.map((dest) => `${dest.skill}\0${dest.mapping.dest}`),
  );
  const sweeps: string[] = [];
  for (const skill of Object.keys(recorded).sort(compareStrings)) {
    for (const key of Object.keys(recorded[skill]).sort(compareStrings)) {
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
  const rules = await readIgnoreRules(root, destIgnoreLevels(site));
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
    (await observedDigest(observed)) === remembered.digest
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
      const digest = await observedDigest(observed);
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
 * What the lock records for each declared raw-byte contract, against what
 * its src digests to now: the raw-byte half of the lock-versus-canonical
 * check. A contract the lock says nothing about is unresolved; one it
 * records another digest for is a stale lock.
 */
export function rawLockViolations(
  skills: SkillDeclaration[],
  raws: RawContracts,
  recorded: Record<string, Resolution>,
  derived: Record<string, Resolution>,
): string[] {
  const violations: string[] = [];
  for (const id of declaredIds(skills)) {
    if (!raws.has(id)) continue;
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

/**
 * Refuses a raw-byte src that stands at, under or over the conformance
 * position of a document contract. Conformance tests are collected by path
 * prefix with no notion of which contract a file belongs to, so a src over
 * that position would distribute the tests and one under it would be pinned
 * as tests.
 */
export function assertSrcsClearOfConformance(
  declaration: Declaration,
  conformanceDirectories: Map<string, string>,
): void {
  for (const id of Object.keys(declaration.contracts).sort(compareStrings)) {
    for (const mapping of declaration.contracts[id].files ?? []) {
      for (const [other, directory] of conformanceDirectories) {
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
