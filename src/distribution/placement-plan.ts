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
  finalDestPath,
  type PlacementMigrationComponent,
  type RecordedDestination,
} from "../contracts/placement-ownership.ts";
import {
  basenameOf,
  MARKER_FILE,
  placedPathOf,
  placementDigest,
  placementKeyOf,
  type RawMaterial,
  srcKeyOf,
} from "../contracts/raw.ts";
import { displayName } from "../filesystem/walk.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import type { RawKind, RawMapping } from "../contracts/sources.ts";
import { joinRelative } from "../filesystem/ignore.ts";
import { vendorHeader } from "./header.ts";
import {
  assertDestNotIgnored,
  assertNotIgnored,
  assertWritableDest,
  firstDisagreement,
  observeDest,
  observedDigest,
  sameBytes,
  type ObservedDest,
} from "./placements.ts";
import type { RawContracts } from "./raw-contracts.ts";

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
