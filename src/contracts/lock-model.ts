import type { Dependencies } from "./declaration.ts";
import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";

export interface Resolution {
  digest: string;
  conformance?: string;
  /** Present on a raw-byte contract; a document contract carries no kind. */
  kind?: "raw";
}

export type Resolutions = Record<string, Resolution>;

/**
 * What the tool wrote at one dest of one skill: which contract, from which src,
 * and what the dest's own content digests to.
 *
 * Recorded per skill and per dest rather than per contract. The gate that
 * keeps gen from replacing a person's directory is a fact about one skill's
 * one path, and a record keyed by contract would call skill B's untouched
 * directory "already written" the moment skill A's was.
 */
export interface Placement {
  contract: string;
  src: string;
  digest: string;
}

/** skill → dest → what stands there. Directory dests keep their trailing slash. */
export type Placements = Record<string, Record<string, Placement>>;

/**
 * Where one source's contracts were taken from, and at which commit.
 *
 * The revision is a commit SHA and never the branch or tag a declaration may
 * name: a branch moves, so a lock recording one would answer "which bytes were
 * adopted" differently on two days with nothing having been adopted in
 * between.
 *
 * The repository stands beside it although the declaration already says it.
 * The revision alone means nothing without the repository it belongs to, and a
 * lock read on its own — by the reviewer of the diff it lands in, by the
 * command that fetches what it names — must not have to hold the declaration
 * open beside it to say what was pinned.
 */
export interface LockSource {
  repository: string;
  revision: string;
  /** Absent is the canonical representation of the backwards-compatible SHA-1 format. */
  objectFormat?: "sha256";
}

export type LockSources = Record<string, LockSource>;

export function buildLock(
  dependencies: Dependencies,
  resolutions: Resolutions,
  present: string[],
  sources: LockSources,
  placements: Placements,
): unknown {
  const resolved: Resolutions = emptyRecord();
  for (const id of [...present].sort(compareStrings)) {
    resolved[id] = resolutions[id];
  }
  // No wall-clock value is recorded anywhere in here. Reproducibility is the
  // reason this file exists, and a timestamp would make every regeneration a
  // change.
  const lock: Record<string, unknown> = { dependencies, resolutions: resolved };
  // A tree that fetches nothing renders the two halves the lock has always
  // had, byte for byte. Written as an empty object instead, every repository
  // with no remote source at all would carry a key answering a question it
  // never asks — and the absence of the key is what lets such a tree be
  // migrated by renaming the file and nothing else.
  if (Object.keys(sources).length > 0) lock["sources"] = sources;
  // The same rule for the placements: a tree distributing no raw bytes renders
  // no key for them. Carried as the lock holds them, never pruned here — the
  // record is gen's memory of what it wrote, and a rendering that dropped an
  // entry would make every other command forget a dest before gen swept it.
  if (Object.keys(placements).length > 0) lock["placements"] = placements;
  return lock;
}
