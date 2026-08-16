// conformance.ts — what a contract's conformance tests digest to.
//
// Framed as `relative-posix-path NUL byte-length NUL content`, in path order,
// so no arrangement of file names and contents can be confused with another.
// The framing is external compatibility: a change to it changes every digest
// ever recorded, so it is stated once, here, and tested against a vector that
// was framed and hashed by hand outside this code.

import {
  compareStrings,
  concatBytes,
  CONTRACTS_DIR,
  digestOfBytes,
} from "./digest.ts";
import { assertPlainChain, isDirectory, readBytes, walkFiles } from "./walk.ts";
import {
  ancestorDirectories,
  IGNORE_FILE,
  joinRelative,
  readIgnoreRules,
  treeDirectoryOf,
} from "./ignore.ts";

export interface ConformanceEntry {
  path: string;
  content: Uint8Array;
}

/**
 * Digest over a conformance tree. Files are fed in path order, each framed as
 * `relative-posix-path NUL byte-length NUL content`, so no arrangement of file
 * names and contents can be confused with another one.
 *
 * Content is hashed as raw bytes and never canonicalized: conformance tests run
 * byte-exactly, so a line ending is part of what was pinned.
 */
export async function conformanceDigestOfEntries(
  entries: ConformanceEntry[],
): Promise<string> {
  const ordered = [...entries].sort((a, b) => compareStrings(a.path, b.path));
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of ordered) {
    chunks.push(encoder.encode(`${entry.path}\0${entry.content.length}\0`));
    chunks.push(entry.content);
  }
  return await digestOfBytes(concatBytes(chunks));
}

/**
 * Reads a conformance tree, or nothing at all when the directory is absent.
 *
 * Files the tree's .gitignore rules exclude are left out. A file a repository
 * ignores is one a fresh checkout will not have, so digesting it would report a
 * mismatch against a tree nobody changed — and the running of the tests would
 * change what the tests pin.
 *
 * The rules are read, never the git index. A file that is ignored yet tracked
 * anyway — force-added — is therefore treated as excluded although a checkout
 * does carry it, which leaves it outside the pin rather than falsely inside it.
 * Consulting the index instead would mean shelling out to git, and a pin whose
 * value depends on a subprocess is not one this tool can compute.
 *
 * The links are refused before the exclusion is applied, never after. Leaving
 * an ignored subtree unscanned would mean a link planted inside it escaped the
 * check that exists to catch it — exclusion narrows what is digested, not what
 * is looked at.
 *
 * The way down to the directory is checked as well as the directory itself. A
 * link at `contracts/<id>/` puts the whole conformance tree outside the
 * boundary, and its digest would then be pinned as if the tree held it.
 */
export async function collectConformanceEntries(
  root: string,
  relative: string,
): Promise<ConformanceEntry[]> {
  await assertPlainChain(root, relative);
  const dir = `${root}/${relative}`;
  if (!(await isDirectory(dir))) return [];
  const found = await walkFiles(dir);
  const rules = await readIgnoreRules(root, [
    ...ancestorDirectories(relative),
    ...found
      .filter(
        (path) => path === IGNORE_FILE || path.endsWith(`/${IGNORE_FILE}`),
      )
      .map((path) => joinRelative(relative, treeDirectoryOf(path))),
  ]);
  const entries: ConformanceEntry[] = [];
  for (const path of found) {
    if (rules.excludes(joinRelative(relative, path))) continue;
    entries.push({
      path,
      content: await readBytes(`${dir}/${path}`, joinRelative(relative, path)),
    });
  }
  return entries;
}

/**
 * The conformance digest pinned for one contract, or null when the contract
 * ships no conformance tests.
 *
 * A directory holding nothing after the exclusion counts as absent, the same as
 * no directory at all: git cannot store an empty directory, so a fresh checkout
 * drops it and any other reading would report a false mismatch.
 */
export async function conformanceDigest(
  root: string,
  id: string,
): Promise<string | null> {
  const entries = await collectConformanceEntries(
    root,
    `${CONTRACTS_DIR}/${id}/conformance`,
  );
  if (entries.length === 0) return null;
  return await conformanceDigestOfEntries(entries);
}
