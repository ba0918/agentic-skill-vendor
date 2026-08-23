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
} from "./ignore.ts";
import {
  assertPlainChain,
  displayName,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  readBytes,
  walkFiles,
} from "./walk.ts";
import { MARKER_FILE, type RawFile, type RawMaterial } from "./raw.ts";
import type { RawMapping } from "./sources.ts";

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
): Promise<RawMaterial[] | null> {
  const materials: RawMaterial[] = [];
  for (const mapping of mappings) {
    const files =
      mapping.kind === "file"
        ? await readFileSrc(root, mapping.src)
        : await readDirectorySrc(root, id, mapping.src, applyIgnoreRules);
    if (files === null || files.length === 0) return null;
    materials.push({ mapping, files });
  }
  return materials;
}

async function readFileSrc(
  root: string,
  src: string,
): Promise<RawFile[] | null> {
  await assertPlainChain(root, src);
  if (!(await isRegularFileOrAbsent(root, src))) return null;
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
  const files: RawFile[] = [];
  for (const path of found) {
    if (rules.excludes(joinRelative(src, path))) continue;
    files.push({
      relative: path,
      content: await readBytes(`${dir}/${path}`, joinRelative(src, path)),
    });
  }
  return files;
}
