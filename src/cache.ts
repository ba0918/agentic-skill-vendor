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
import { ancestorDirectories, readIgnoreRules } from "./filesystem/ignore.ts";
import type { LockSources } from "./manifest.ts";
import { TOOL_DIR } from "./sources.ts";
import {
  assertPlainChain,
  displayName,
  isDirectoryOrAbsent,
  listEntries,
} from "./filesystem/walk.ts";

/** Where fetched material is kept, relative to the tree root. */
export const CACHE_DIR = `${TOOL_DIR}/cache`;

/**
 * Where one revision's whole fetch sits: its source, then the revision.
 *
 * This is the level a fetch is placed at, in one move. A directory standing
 * here means that revision was taken up completely, and nothing writes into it
 * a file at a time — so no run can find a half-filled one and read it as a
 * fetch that finished.
 */
export function cacheRevisionDirOf(source: string, revision: string): string {
  return `${CACHE_DIR}/${source}/${revision}`;
}

/** Where one fetched file sits: its source, the revision, then its own path. */
export function cacheSiteOf(
  source: string,
  revision: string,
  path: string,
): string {
  return `${cacheRevisionDirOf(source, revision)}/${path}`;
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
 * A temporary a stopped fetch left behind falls to the same rule rather than to
 * a clause of its own: its name carries the temporary suffix, so it is never
 * the revision the lock pins, and a second branch saying so would be the same
 * fact written twice. What matters is that it goes — a half-built directory is
 * not a revision and must never be read as one.
 *
 * Only names the directory listing itself supplies are removed, and the listing
 * refuses a symlink before it hands one over. A name read off disk cannot carry
 * a separator, so nothing here can be steered into removing a path outside the
 * cache — except through the chain above it: the removal is recursive, and a
 * link at the tool directory itself would resolve every name outside the tree,
 * so the chain is refused first.
 */
export async function pruneCache(
  root: string,
  sources: LockSources,
): Promise<string[]> {
  await assertPlainChain(root, CACHE_DIR);
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
  return await isIgnored(root, CACHE_DIR);
}

/**
 * True when the tree's ignore rules exclude the directory at `relative`. It
 * is asked as a directory: the tool's own directories are what this answers
 * for, and a rule written with a trailing slash matches only those.
 */
export async function isIgnored(
  root: string,
  relative: string,
): Promise<boolean> {
  const rules = await readIgnoreRules(root, ancestorDirectories(relative));
  return rules.excludes(relative, true);
}

/**
 * The line a command prints over a tool directory the repository tracks. One
 * wording for the cache and the staging directory alike: the remedy is the
 * same line in .gitignore.
 */
export function unignoredWarning(relative: string): string {
  return (
    `warning: ${relative} is not ignored by this repository; add ` +
    `/${relative.split("/")[0]}/ to .gitignore so the tool's working ` +
    `files are never committed`
  );
}
