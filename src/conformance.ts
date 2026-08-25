// conformance.ts — what a contract's conformance tests digest to.
//
// Framed as `relative-posix-path NUL byte-length NUL content`, in path order,
// so no arrangement of file names and contents can be confused with another.
// The framing is external compatibility: a change to it changes every digest
// ever recorded, so it is stated once, here, and tested against a vector that
// was framed and hashed by hand outside this code.

import { framedDigest } from "./raw.ts";
import {
  assertPlainChain,
  dirNameOf,
  isDirectoryOrAbsent,
  readBytes,
  walkFiles,
} from "./filesystem/walk.ts";
import {
  ancestorDirectories,
  IGNORE_FILE,
  joinRelative,
  readIgnoreRules,
  treeDirectoryOf,
} from "./filesystem/ignore.ts";

export interface ConformanceEntry {
  path: string;
  content: Uint8Array;
}

/**
 * The directory a contract's conformance tests sit in: beside its canonical
 * text, under the contract's own name.
 *
 * Derived from where the text is rather than from a fixed directory, because
 * the text no longer has one fixed home. A contract fetched from another
 * repository, and a local one whose text a declaration places outside the
 * conventional directory, both keep their tests in the same relation to the
 * text — which is what lets one rule answer for every contract the tool
 * digests.
 */
export function conformanceDirectory(site: string, id: string): string {
  return `${dirNameOf(site)}/${id}/conformance`;
}

/**
 * Refuses a link anywhere on the way into a contract's material — the canonical
 * text, and the conformance tests in the directory beside it.
 *
 * Stated once and called from every command's way in. Whether a link is refused
 * is a fact about the tree, so it cannot depend on which command is looking:
 * left to the commands that read the tests, a link at `contracts/<id>/` or at
 * the conformance directory itself stopped `verify` while `gen`, which never
 * reads them, expanded the tree and said nothing.
 *
 * The two paths are checked in the order a run reaches them, and the first to
 * refuse is the one a refusal names. Checking the text first is what makes a
 * link at `contracts/` name the file the run was about to read rather than a
 * directory the tree need not even hold.
 */
export async function assertPlainContractPaths(
  root: string,
  site: string,
  id: string,
): Promise<void> {
  await assertPlainChain(root, site);
  await assertPlainChain(root, conformanceDirectory(site, id));
  // Asked for its refusal rather than its answer. Whether the tests are there
  // is the business of the commands that digest them; whether something else
  // entirely stands where that directory belongs is the business of every
  // command, including the ones that never read below it.
  await isDirectoryOrAbsent(root, conformanceDirectory(site, id));
}

/**
 * Digest over a conformance tree: the shared framing, over the files as they
 * sit under the conformance directory. Content is hashed as raw bytes and
 * never canonicalized: conformance tests run byte-exactly, so a line ending
 * is part of what was pinned.
 */
export async function conformanceDigestOfEntries(
  entries: ConformanceEntry[],
): Promise<string> {
  return await framedDigest(entries);
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
 * `applyIgnoreRules` is false for material fetched from another repository,
 * and that is not an exception to the rule above but the same rule read
 * correctly. The question is always "would a checkout carry this file", and
 * for fetched material the checkout that decides is the source repository's —
 * whose own rules already settled it before the listing this came from was
 * ever produced. This tree's rules answer a different question, and they
 * exclude the whole cache on purpose: applied here, every fetched conformance
 * tree would digest as absent, and a repository that followed the advice to
 * ignore the cache would silently stop pinning any of them.
 *
 * The way down to the directory is checked as well as the directory itself. A
 * link at `contracts/<id>/` puts the whole conformance tree outside the
 * boundary, and its digest would then be pinned as if the tree held it.
 */
export async function collectConformanceEntries(
  root: string,
  relative: string,
  applyIgnoreRules: boolean,
): Promise<ConformanceEntry[]> {
  await assertPlainChain(root, relative);
  const dir = `${root}/${relative}`;
  if (!(await isDirectoryOrAbsent(root, relative))) return [];
  const found = await walkFiles(dir, relative);
  const rules = applyIgnoreRules
    ? await treeIgnoreRules(root, relative, found)
    : { excludes: () => false };
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
 * The tree's own ignore rules, as they apply to one conformance directory.
 */
async function treeIgnoreRules(
  root: string,
  relative: string,
  found: string[],
) {
  return await readIgnoreRules(root, [
    ...ancestorDirectories(relative),
    ...found
      .filter(
        (path) => path === IGNORE_FILE || path.endsWith(`/${IGNORE_FILE}`),
      )
      .map((path) => joinRelative(relative, treeDirectoryOf(path))),
  ]);
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
  site: string,
  id: string,
  applyIgnoreRules: boolean,
): Promise<string | null> {
  const entries = await collectConformanceEntries(
    root,
    conformanceDirectory(site, id),
    applyIgnoreRules,
  );
  if (entries.length === 0) return null;
  return await conformanceDigestOfEntries(entries);
}
