// walk.ts — every read and write the tool makes, and the boundary they respect.
//
// One rule runs through all of it: a symlink inside the tree is refused, never
// followed. A link planted in generated state has no legitimate purpose, and
// following one would let it read a file outside the tree or have the tree's
// output written over one. Refusing costs nothing and closes the escape
// structurally rather than case by case.
//
// A second rule governs how those messages name a path: as the tree spells it,
// whether the message reports a refusal or a read that failed. One file that
// reads as two different paths depending on which call happened to fail on it
// is the harder thing to follow, and the machine's own location reaches the
// reader anyway — the underlying error is quoted, and it carries the absolute
// path. The tree root itself is the one exception: named as it was given, there
// being nothing yet for it to be relative to.

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
  isRegularFile: boolean;
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
 *
 * `site` is how those two refusals name the directory. A caller inside a tree
 * passes the path the tree spells, which is what the reader of the message
 * holds; the absolute path it reads from is no answer to "which file".
 */
export async function readEntries(
  dir: string,
  site = dir,
): Promise<DirectoryEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (cause) {
    throw new ConfigError(`cannot read ${site}: ${describeCause(cause)}`);
  }
  const entries: DirectoryEntry[] = [];
  for (const name of names.sort(compareStrings)) {
    let info: Stats;
    try {
      info = await fs.lstat(`${dir}/${name}`);
    } catch (cause) {
      throw new ConfigError(
        `cannot inspect ${site}/${name}: ${describeCause(cause)}`,
      );
    }
    entries.push({
      name,
      isSymlink: info.isSymbolicLink(),
      isDirectory: info.isDirectory(),
      isRegularFile: info.isFile(),
    });
  }
  return entries;
}

/**
 * What the tree holds at `relative`, or null where it holds nothing.
 *
 * A link is refused here rather than described, so no caller has to remember
 * to ask: every question below is about what the tree holds at a path, and a
 * link is not an answer to it — it is a path leading out of the tree.
 */
async function kindAt(root: string, relative: string): Promise<Stats | null> {
  let info: Stats;
  try {
    info = await fs.lstat(`${root}/${relative}`);
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw new ConfigError(
      `cannot inspect ${relative}: ${describeCause(cause)}`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new ConfigError(
      `symlink is not allowed inside the tree: ${relative}`,
    );
  }
  return info;
}

/**
 * True for a directory, false where the tree holds nothing at the path, and a
 * refusal for anything else standing there.
 *
 * The two outcomes are in the name because collapsing them is a whole class of
 * bug. Asked as "is this a directory", a regular file, a named pipe or a socket
 * standing at the path answers no — the same answer an empty tree gives — and
 * every caller then takes the branch written for "nothing is there yet". A
 * regular file at `skills/` made every skill in the tree vanish that way: gen
 * rewrote the lock with no dependencies at all and finished at 0, and verify
 * called the result clean.
 *
 * Nothing here opens the path. A named pipe would block the run until something
 * on the other side wrote, so the kind is read from the entry itself.
 */
export async function isDirectoryOrAbsent(
  root: string,
  relative: string,
): Promise<boolean> {
  const info = await kindAt(root, relative);
  if (info === null) return false;
  if (!info.isDirectory()) {
    throw new ConfigError(`${relative}: not a directory`);
  }
  return true;
}

/**
 * Every file under `dir`, as relative posix paths in sorted order.
 *
 * A symlink is refused rather than followed. Following one would let a link
 * planted inside the tree read, or be overwritten onto, a file outside it —
 * and generated vendoring state has no legitimate reason to contain links, so
 * refusing costs nothing and closes the escape structurally.
 */
export async function walkFiles(dir: string, site = dir): Promise<string[]> {
  const found: string[] = [];
  await walkInto(dir, site, "", found);
  return found.sort(compareStrings);
}

/**
 * Two names travel down together, and they answer different questions. `prefix`
 * is where a file sits within the walk, which is what the caller collects;
 * `site` is where it sits within the tree, which is what a refusal names.
 */
async function walkInto(
  dir: string,
  site: string,
  prefix: string,
  into: string[],
): Promise<void> {
  for (const entry of await readEntries(dir, site)) {
    const path = `${dir}/${entry.name}`;
    const named = `${site}/${entry.name}`;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymlink) {
      throw new ConfigError(
        `symlink is not allowed inside a scanned tree: ${named}`,
      );
    }
    if (entry.isDirectory) {
      await walkInto(path, named, relative, into);
      continue;
    }
    // Collected to be read in full, so an entry that cannot be read as a file
    // is refused here rather than carried out of the walk. A named pipe taken
    // for an ordinary file does not fail on the read — it blocks the run until
    // something on the other side writes, which never comes.
    if (!entry.isRegularFile) {
      throw new ConfigError(`${named}: not a regular file`);
    }
    into.push(relative);
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
  root: string,
  relative: string,
  content: Uint8Array,
): Promise<void> {
  const path = `${root}/${relative}`;
  const temporary = `${path}.tmp`;
  await assertWritableTarget(temporary, `${relative}.tmp`);
  await assertWritableTarget(path, relative);
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, path);
  } catch (cause) {
    await fs.rm(temporary).catch(() => {});
    throw new ConfigError(`cannot write ${relative}: ${describeCause(cause)}`);
  }
}

/**
 * Refuses a path the run is about to write at unless writing there is what it
 * looks like: nothing at all, or a regular file to be replaced.
 *
 * A link is refused because writing through one lands outside the tree. Any
 * other kind is refused because the write would not land anywhere: opening a
 * named pipe for writing is accepted and then waits for a reader that never
 * comes, and the run stops answering rather than failing. Both the file and the
 * temporary beside it are asked, since the bytes go through the temporary
 * first — a pipe planted there blocked every run that wrote anything at all.
 */
async function assertWritableTarget(path: string, site: string): Promise<void> {
  let info: Stats;
  try {
    info = await fs.lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) return;
    throw new ConfigError(`cannot inspect ${site}: ${describeCause(cause)}`);
  }
  if (info.isSymbolicLink()) {
    throw new ConfigError(`refusing to write through a symlink: ${site}`);
  }
  if (!info.isFile()) {
    throw new ConfigError(`refusing to write over ${site}: not a regular file`);
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

/**
 * True for a regular file, false where the tree holds nothing at the path, and
 * a refusal for anything else standing there.
 *
 * The counterpart of `isDirectoryOrAbsent`, and it exists for the same reason.
 * Nothing being there is a fact a caller can act on: a skill directory with no
 * SKILL.md declares nothing, a contract with no canonical text is a closure
 * gap, a tree with no manifest has adopted nothing yet. Something standing
 * there that the run cannot read as a file is not that fact — it is the run
 * being unable to find out — and answering the two alike is what let a
 * directory named SKILL.md retire every contract a skill declared.
 */
export async function isRegularFileOrAbsent(
  root: string,
  relative: string,
): Promise<boolean> {
  const info = await kindAt(root, relative);
  if (info === null) return false;
  if (!info.isFile()) {
    throw new ConfigError(`${relative}: not a regular file`);
  }
  return true;
}

/** The directory the path sits in; the current directory when it names none. */
export function dirNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
}

export async function ensureParentDirectory(
  root: string,
  relative: string,
): Promise<void> {
  const parent = dirNameOf(relative);
  try {
    await fs.mkdir(`${root}/${parent}`, { recursive: true });
  } catch (cause) {
    throw new ConfigError(`cannot create ${parent}: ${describeCause(cause)}`);
  }
}

/**
 * Refuses a root that names no directory.
 *
 * Answered once, before any command reads anything, rather than by whichever
 * file each command happens to open first. Left to that, the same mistyped path
 * was a usage error under gen and a list of drift under verify — the tree that
 * is not there reads as a tree where everything is missing.
 *
 * The path is followed rather than inspected. The refusal of links is about
 * links planted inside the tree; a tree reached through one — a symlinked home
 * or temporary directory — is how the user named it, not an escape from it.
 */
export async function assertTreeRoot(root: string): Promise<void> {
  let info: Stats;
  try {
    info = await fs.stat(root);
  } catch (cause) {
    if (isNotFound(cause)) throw new ConfigError(`no such tree: ${root}`);
    throw new ConfigError(`cannot inspect ${root}: ${describeCause(cause)}`);
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`not a directory: ${root}`);
  }
}
