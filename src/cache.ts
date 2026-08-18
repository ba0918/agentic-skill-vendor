// cache.ts — where fetched canonical text is kept, and why it is never the
// authority over anything.
//
// The cache is disposable by design. Nothing in it is committed, nothing in it
// decides what the lock records, and deleting all of it costs one fetch. What
// it buys is that `gen` and `verify` never reach the network: the bytes another
// repository is authority over are already on disk by the time they run.
//
// The layout puts the revision in a directory level of its own, which is what
// makes retiring a superseded version the removal of one directory rather than
// a comparison against the file list of another.

import * as fs from "node:fs/promises";
import { ConfigError, describeCause } from "./errors.ts";
import { compareStrings } from "./digest.ts";
import { ancestorDirectories, readIgnoreRules } from "./ignore.ts";
import type { LockSources } from "./manifest.ts";
import { TOOL_DIR } from "./sources.ts";
import { displayName, isDirectoryOrAbsent, listEntries } from "./walk.ts";

/** Where fetched material is kept, relative to the tree root. */
export const CACHE_DIR = `${TOOL_DIR}/cache`;

/** Where one fetched file sits: its source, the revision, then its own path. */
export function cacheSiteOf(
  source: string,
  revision: string,
  path: string,
): string {
  return `${CACHE_DIR}/${source}/${revision}/${path}`;
}

/**
 * Clears everything the lock does not name: a source it no longer records, and
 * every revision of a source other than the one it is pinned at.
 *
 * The lock is the only authority consulted. A cache entry the lock does not
 * name cannot be reached by any run — nothing looks a contract up by anything
 * but the pinned revision — so keeping it grows the tree by one full copy per
 * update and leaves a reader unable to tell which directory the distribution
 * actually came from.
 *
 * Only names the directory listing itself supplies are removed, and the listing
 * refuses a symlink before it hands one over. A name read off disk cannot carry
 * a separator, so nothing here can be steered into removing a path outside the
 * cache.
 */
export async function pruneCache(
  root: string,
  sources: LockSources,
): Promise<string[]> {
  const removed: string[] = [];
  for (const source of await cacheEntries(root, CACHE_DIR)) {
    const pinned = sources[source]?.revision;
    if (pinned === undefined) {
      removed.push(`${CACHE_DIR}/${source}`);
      continue;
    }
    for (const revision of await cacheEntries(root, `${CACHE_DIR}/${source}`)) {
      if (revision !== pinned) {
        removed.push(`${CACHE_DIR}/${source}/${revision}`);
      }
    }
  }
  for (const site of removed.sort(compareStrings)) {
    try {
      await fs.rm(`${root}/${site}`, { recursive: true, force: true });
    } catch (cause) {
      throw new ConfigError(
        `cannot remove ${displayName(site)}: ${describeCause(cause)}`,
      );
    }
  }
  return removed;
}

/** The directories one level inside the cache, or none where there is none. */
async function cacheEntries(root: string, relative: string): Promise<string[]> {
  if (!(await isDirectoryOrAbsent(root, relative))) return [];
  return (await listEntries(`${root}/${relative}`, relative))
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name);
}

/**
 * True when the tree's own ignore rules keep the cache out of the repository.
 *
 * Asked by the commands that fill the cache, which warn rather than refuse. A
 * committed cache is a second copy of every fetched contract standing beside
 * the vendored ones — the mirror this design exists to avoid, and the file a
 * later reader edits believing it is canonical — but it is a state of the
 * repository's own configuration, not something the run can put right, and a
 * fetch that refused to run over it would leave the tree unable to build.
 *
 * The rules are read the way git orders them, through the same module the
 * conformance digest uses. A second reading of `.gitignore` written here would
 * be a copy of a rule set, and a copy diverges silently.
 */
export async function cacheIsIgnored(root: string): Promise<boolean> {
  const rules = await readIgnoreRules(root, ancestorDirectories(CACHE_DIR));
  return rules.excludes(CACHE_DIR);
}
