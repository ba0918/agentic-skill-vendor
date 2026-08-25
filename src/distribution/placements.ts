// placements.ts — distributing raw-byte contracts: what gen writes at each
// skill's dests, what it records about them, and what it may replace.
//
// A document contract lands in a directory the tool owns whole, so the tool
// can list it to learn what it wrote. A raw-byte contract lands where the
// table says, and the only memory of what was written there is the lock's
// placements. Everything in this module reads that memory before it touches a
// path, and writes it only after the path holds what the memory will say.

import { ConfigError } from "../errors.ts";
import type { Placement } from "../contracts/lock-model.ts";
import { basenameOf, MARKER_FILE } from "../contracts/raw.ts";
import type { RawMapping } from "../contracts/sources.ts";
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
export function firstDisagreement(
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
