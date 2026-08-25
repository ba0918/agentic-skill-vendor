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
import type { Placement, Placements } from "../contracts/lock-model.ts";
import { finalDestPath } from "../contracts/placement-ownership.ts";
import {
  basenameOf,
  MARKER_FILE,
  placedPathOf,
  placementKeyOf,
  type RawMaterial,
  srcKeyOf,
} from "../contracts/raw.ts";
import type { Declaration, RawMapping } from "../contracts/sources.ts";
import { type SkillDeclaration, SKILLS_DIR } from "../contracts/declaration.ts";
import { vendorHeader } from "./header.ts";
import {
  assertPlainChain,
  displayName,
  kindAt,
  readBytes,
  dirNameOf,
  walkFiles,
} from "../filesystem/walk.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import {
  ancestorDirectories,
  type IgnoreRules,
  joinRelative,
  readIgnoreRules,
} from "../filesystem/ignore.ts";
import { framedDigest } from "../contracts/raw.ts";
import type { RawKind } from "../contracts/sources.ts";
import type { PlacementMigrationComponent } from "../contracts/placement-ownership.ts";
import { rawMappingsOf, type RawContracts } from "./raw-contracts.ts";

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
export interface ObservedDest {
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
export async function observeDest(
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
export async function observedDigest(observed: ObservedDest): Promise<string> {
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

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Every dest the declared raw-byte contracts land at, with the gate applied
 * in order: the dest is absent; or the lock records a placement at that path
 * for this skill and the dest still digests to it; or the dest already holds
 * exactly what the run writes, ignored files included — the recovery path,
 * which the run reports as a claim.
 */
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

export async function planMigration(
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
export async function planSweep(
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
export async function assertNotIgnored(
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
export async function assertDestNotIgnored(
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
export async function assertWritableDest(
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
export function placedFilesOf(
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
