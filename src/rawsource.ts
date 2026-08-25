// rawsource.ts — reading a raw-byte contract's files from where the tree
// holds them.
//
// The canonical side of a raw-byte contract is whatever the table's `files`
// keys point at: one file, or a directory walked whole. What is read is read
// as bytes and never canonicalized, and what is refused is refused before the
// ignore rules narrow anything — exclusion narrows what is digested, never
// what is looked at.

import { ConfigError } from "./errors.ts";
import {
  ancestorDirectories,
  IGNORE_FILE,
  joinRelative,
  readIgnoreRules,
} from "./filesystem/ignore.ts";
import {
  assertPlainChain,
  dirNameOf,
  displayName,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  readBytes,
  walkFiles,
} from "./filesystem/walk.ts";
import {
  MARKER_FILE,
  type RawFile,
  type RawMaterial,
  srcKeyOf,
} from "./raw.ts";
import { compareStrings } from "./digest.ts";
import type { RawMapping } from "./sources.ts";
import { createDistributionIgnore } from "./distribution-ignore.ts";

/**
 * The files of every mapping of one raw-byte contract, or null where any src
 * is absent — the raw-byte form of "the canonical text is not there".
 *
 * A directory src holding nothing after the ignore rules counts as absent: git
 * cannot store an empty directory, so a checkout cannot tell the two apart.
 */
export async function readRawMaterials(
  root: string,
  id: string,
  mappings: RawMapping[],
  applyIgnoreRules: boolean,
  sharedIgnore: readonly string[] = [],
  contractIgnore: readonly string[] = [],
): Promise<RawMaterial[] | RawAbsence> {
  const materials: RawMaterial[] = [];
  const absent: string[] = [];
  for (const mapping of mappings) {
    const files =
      mapping.kind === "file"
        ? await readFileSrc(root, mapping.src, applyIgnoreRules)
        : await readDirectorySrc(
            root,
            id,
            mapping.src,
            applyIgnoreRules,
            sharedIgnore,
            contractIgnore,
          );
    if (files === null || files.length === 0) {
      absent.push(srcKeyOf(mapping));
      continue;
    }
    materials.push({ mapping, files });
  }
  if (absent.length > 0) {
    return { missing: absent.sort(compareStrings)[0] };
  }
  return materials;
}

/** A contract the tree does not hold, named by the first absent src in path order. */
export interface RawAbsence {
  missing: string;
}

/**
 * A file src, absent where the tree holds nothing there — or where its ignore
 * rules exclude it, since a clean checkout holds nothing there either.
 */
async function readFileSrc(
  root: string,
  src: string,
  applyIgnoreRules: boolean,
): Promise<RawFile[] | null> {
  await assertPlainChain(root, src);
  if (!(await isRegularFileOrAbsent(root, src))) return null;
  if (applyIgnoreRules) {
    const rules = await readIgnoreRules(
      root,
      ancestorDirectories(dirNameOf(src)),
    );
    if (rules.excludes(src)) return null;
  }
  return [{ relative: "", content: await readBytes(`${root}/${src}`, src) }];
}

/**
 * A directory src, walked whole with its links refused, then narrowed by the
 * ignore rules of the tree above it.
 *
 * Two names inside it are refused outright. A `.gitignore` would land in the
 * consumer's working tree and could stop git tracking the very files it came
 * with; a `.vendored` at the top would be digested on this side and excluded
 * on the dest side, so no copy could ever verify.
 */
async function readDirectorySrc(
  root: string,
  id: string,
  src: string,
  applyIgnoreRules: boolean,
  sharedIgnore: readonly string[],
  contractIgnore: readonly string[],
): Promise<RawFile[] | null> {
  await assertPlainChain(root, src);
  if (!(await isDirectoryOrAbsent(root, src))) return null;
  const dir = `${root}/${src}`;
  const found = await walkFiles(dir, src);
  for (const path of found) {
    if (path === IGNORE_FILE || path.endsWith(`/${IGNORE_FILE}`)) {
      throw new ConfigError(
        `${displayName(joinRelative(src, path))}: a ${IGNORE_FILE} inside a ` +
          `directory ${id} distributes would govern what git tracks in every ` +
          `skill it lands in; keep it out of the src`,
      );
    }
    if (path === MARKER_FILE) {
      throw new ConfigError(
        `${displayName(joinRelative(src, path))}: ${MARKER_FILE} at the top ` +
          `of a directory ${id} distributes is the marker gen writes, and a ` +
          `copy carrying one of its own could never verify`,
      );
    }
  }
  const rules = applyIgnoreRules
    ? await readIgnoreRules(root, ancestorDirectories(src))
    : { excludes: () => false };
  const repositoryPaths = found.filter(
    (path) => !rules.excludes(joinRelative(src, path)),
  );
  const distribution = createDistributionIgnore(sharedIgnore, contractIgnore);
  const selected = repositoryPaths.filter(
    (path) => !distribution.excludes(path),
  );
  if (repositoryPaths.length > 0 && selected.length === 0) {
    throw new ConfigError(
      `${displayName(src)}/: distribution ignore rules exclude every file ` +
        `of directory mapping ${id}`,
    );
  }
  return await Promise.all(
    selected.map(async (path) => ({
      relative: path,
      content: await readBytes(`${dir}/${path}`, joinRelative(src, path)),
    })),
  );
}
