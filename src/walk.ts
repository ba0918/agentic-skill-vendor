// walk.ts — every read and write the tool makes, and the boundary they respect.
//
// One rule runs through all of it: a symlink inside the tree is refused, never
// followed. A link planted in generated state has no legitimate purpose, and
// following one would let it read a file outside the tree or have the tree's
// output written over one. Refusing costs nothing and closes the escape
// structurally rather than case by case.

import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { ConfigError, describeCause } from "./errors.ts";
import { compareStrings } from "./digest.ts";

/**
 * True when the reason a file system call failed is that nothing is there.
 *
 * The runtimes agree on the errno and disagree on everything around it, so the
 * code is what this reads. Every other failure means the tool could not find
 * out what the tree says, which is a refusal rather than an absence.
 */
export function isNotFound(cause: unknown): boolean {
  return (cause as { code?: string } | null)?.code === "ENOENT";
}

/** One entry of a directory, with its kind resolved without following it. */
export interface DirectoryEntry {
  name: string;
  isSymlink: boolean;
  isDirectory: boolean;
}

/**
 * The entries of `dir`, sorted by name, each with its own kind.
 *
 * Every entry is stat'd rather than taken from the kind the directory listing
 * reports. A listing answers from the file system's `d_type`, which not every
 * file system fills in, and an entry that came back as "unknown" would be read
 * as an ordinary file — silently retiring the symlink refusal this module is
 * built around. One extra call per entry is what keeps that refusal a fact
 * about the file rather than about the file system it happens to sit on.
 *
 * Both calls are rescued here rather than at each caller. Every enumeration the
 * tool makes — declarations, vendor directories, the linted tree, the walk —
 * comes through this one function, so a directory the run may not list stops it
 * with a described refusal instead of an exception escaping as a stack trace.
 * The two calls fail independently: a directory readable but not searchable
 * lists its names and refuses every stat under it.
 */
export async function readEntries(dir: string): Promise<DirectoryEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (cause) {
    throw new ConfigError(`cannot read ${dir}: ${describeCause(cause)}`);
  }
  const entries: DirectoryEntry[] = [];
  for (const name of names.sort(compareStrings)) {
    let info: Stats;
    try {
      info = await fs.lstat(`${dir}/${name}`);
    } catch (cause) {
      throw new ConfigError(
        `cannot inspect ${dir}/${name}: ${describeCause(cause)}`,
      );
    }
    entries.push({
      name,
      isSymlink: info.isSymbolicLink(),
      isDirectory: info.isDirectory(),
    });
  }
  return entries;
}

/** True for a real directory; a symlink in its place is refused outright. */
export async function isDirectory(path: string): Promise<boolean> {
  let info: Stats;
  try {
    info = await fs.lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw new ConfigError(`cannot read ${path}: ${describeCause(cause)}`);
  }
  if (info.isSymbolicLink()) {
    throw new ConfigError(`symlink is not allowed here: ${path}`);
  }
  return info.isDirectory();
}

/**
 * Every file under `dir`, as relative posix paths in sorted order.
 *
 * A symlink is refused rather than followed. Following one would let a link
 * planted inside the tree read, or be overwritten onto, a file outside it —
 * and generated vendoring state has no legitimate reason to contain links, so
 * refusing costs nothing and closes the escape structurally.
 */
export async function walkFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  await walkInto(dir, "", found);
  return found.sort(compareStrings);
}

async function walkInto(
  dir: string,
  prefix: string,
  into: string[],
): Promise<void> {
  for (const entry of await readEntries(dir)) {
    const path = `${dir}/${entry.name}`;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside a scanned tree: ${path}`,
      );
    }
    if (entry.isDirectory) await walkInto(path, relative, into);
    else into.push(relative);
  }
}

/**
 * Writes `content` at `path` through a temporary file in the same directory.
 *
 * The temporary file is a sibling rather than an OS temporary: a rename is only
 * atomic within one file system, and the OS temporary directory is frequently
 * on another one.
 */
export async function atomicWriteFile(
  path: string,
  content: Uint8Array,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await refuseSymlink(temporary);
  await refuseSymlink(path);
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, path);
  } catch (cause) {
    await fs.rm(temporary).catch(() => {});
    throw new ConfigError(`cannot write ${path}: ${describeCause(cause)}`);
  }
}

async function refuseSymlink(path: string): Promise<void> {
  try {
    const info = await fs.lstat(path);
    if (info.isSymbolicLink()) {
      throw new ConfigError(`refusing to write through a symlink: ${path}`);
    }
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    if (isNotFound(cause)) return;
    throw new ConfigError(`cannot inspect ${path}: ${describeCause(cause)}`);
  }
}

/**
 * Decodes bytes that must be UTF-8. Input this tool digests or parses is
 * refused when it is not, rather than being repaired into something that would
 * digest differently from what the author wrote.
 */
export function decodeUtf8(bytes: Uint8Array, site: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${site}: not valid UTF-8`);
  }
}

/**
 * Reads a file as the bytes it holds, naming it as `site` when it cannot.
 *
 * Every raw read the tool makes comes through here. A read that fails says
 * nothing about the tree — it says the run could not find out what the tree
 * says — so it is a refusal on standard error, never an exception escaping to
 * the top with a stack trace and an exit code the contract does not define.
 */
export async function readBytes(
  path: string,
  site: string,
): Promise<Uint8Array> {
  try {
    return await fs.readFile(path);
  } catch (cause) {
    throw new ConfigError(`cannot read ${site}: ${describeCause(cause)}`);
  }
}

/** Reads a file that must be UTF-8 text. */
export async function readTextFile(
  path: string,
  site: string,
): Promise<string> {
  return decodeUtf8(await readBytes(path, site), site);
}

/**
 * Refuses a symlink anywhere along a path inside the tree.
 *
 * Checking only the last component would not be enough: a link at any level
 * makes every path below it resolve outside the tree, so a directory created
 * under it would be created somewhere the run was never pointed at.
 */
export async function assertPlainChain(
  root: string,
  relative: string,
): Promise<void> {
  let path = root;
  for (const part of relative.split("/")) {
    path = `${path}/${part}`;
    let info: Stats;
    try {
      info = await fs.lstat(path);
    } catch (cause) {
      if (isNotFound(cause)) return;
      throw new ConfigError(
        `cannot inspect ${relative}: ${describeCause(cause)}`,
      );
    }
    if (info.isSymbolicLink()) {
      throw new ConfigError(
        `symlink is not allowed inside the tree: ${relative}`,
      );
    }
  }
}

export async function isRegularFile(path: string): Promise<boolean> {
  let info: Stats;
  try {
    info = await fs.lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw new ConfigError(`cannot inspect ${path}: ${describeCause(cause)}`);
  }
  if (info.isSymbolicLink()) {
    throw new ConfigError(`symlink is not allowed inside the tree: ${path}`);
  }
  return info.isFile();
}

export async function ensureParentDirectory(path: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  try {
    await fs.mkdir(parent, { recursive: true });
  } catch (cause) {
    throw new ConfigError(`cannot create ${parent}: ${describeCause(cause)}`);
  }
}
