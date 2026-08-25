import * as fs from "node:fs/promises";
import { sha256Hex } from "../contracts/digest.ts";
import { compareStrings } from "../ordering.ts";

/** Writes `content` at `path`, creating the parent directories it needs. */
export async function writeFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(path, content);
}

/** Adds `text` to the end of an existing file: an edit the tool must notice. */
export async function append(path: string, text: string): Promise<void> {
  await fs.writeFile(path, (await fs.readFile(path, "utf8")) + text);
}

/**
 * The uid a runtime would report, or undefined where it has no getuid method.
 *
 * The permission gating below needs one answer on every runtime this package
 * claims to support. A runtime with no `process` global at all — Deno — must
 * not be reached for `process.getuid` directly: reading the global throws a
 * ReferenceError. The helper is handed an environment-like value instead, so
 * the module's own `process` reference stays behind a guard in one place.
 */
export function processUidOf(env: unknown): number | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  const getuid = (env as { getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid() : undefined;
}

/**
 * True where the permission bits a case sets are the ones the run obeys.
 *
 * A process running as root reads through a mode of 000, so a case built on
 * one would assert that a failure was handled while no failure ever happened.
 * Skipping is the honest answer: the behaviour is unobservable here.
 */
export const PERMISSIONS_APPLY =
  processUidOf(typeof process === "undefined" ? undefined : process) !== 0;

/**
 * Runs `fn` while nothing may read `path`, and puts the mode back afterwards.
 *
 * The restore is not tidiness. A directory nobody may read is one the fixture
 * teardown cannot walk either, so leaving it would replace whatever the case
 * asserts with a failure to remove a temporary directory.
 */
export async function withUnreadable<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { mode } = await fs.stat(path);
  await fs.chmod(path, 0o000);
  try {
    return await fn();
  } finally {
    await fs.chmod(path, mode);
  }
}

/**
 * Moves what sits at `relative` out of the tree and leaves a link to it behind.
 * Answers with the directory that now holds the moved content, so a case can
 * state that nothing outside the tree was read through or written to.
 */
export async function escapeThrough(
  root: string,
  relative: string,
): Promise<string> {
  const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
  await fs.mkdir(outside, { recursive: true });
  // The relative path is folded into one file name by replacing its separators.
  // `replaceAll` was once used for that, and it is not injective: `a/b` and
  // `a-b` folded to the same name, so two otherwise distinct escapes could hit
  // the same file. Percent-encoding keeps one relative to one target while
  // staying a legal file name.
  const target = `${outside}/${relative.replaceAll("/", "%2F")}`;
  await fs.rename(`${root}/${relative}`, target);
  await fs.symlink(target, `${root}/${relative}`);
  return outside;
}

/** Replaces `path` with a symlink to `target`. */
export async function replaceWithSymlink(
  path: string,
  target: string,
): Promise<void> {
  await fs.rm(path, { recursive: true }).catch(() => {});
  const parent = path.slice(0, path.lastIndexOf("/"));
  await fs.mkdir(parent, { recursive: true });
  await fs.symlink(target, path);
}

/**
 * Maps every entry under `root` to a description of its content: the SHA-256
 * of a file's bytes, or `symlink:<target>` for a link. Comparing two snapshots
 * is how a test states "this run changed nothing", and links are described
 * rather than followed so that a link swapped for a file still shows up as a
 * change.
 */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  await walk(root, "", snapshot);
  return snapshot;
}

async function walk(
  dir: string,
  prefix: string,
  into: Map<string, string>,
): Promise<void> {
  const names = (await fs.readdir(dir)).sort(compareStrings);
  for (const name of names) {
    const path = `${dir}/${name}`;
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    // Each entry is stat'd rather than read off the directory listing: a
    // listing reports an entry's type from the file system's d_type, which
    // some file systems do not fill in, and a symlink that came back as
    // "unknown" would be recorded as an ordinary file.
    const entry = await fs.lstat(path);
    if (entry.isSymbolicLink()) {
      into.set(rel, `symlink:${await fs.readlink(path)}`);
    } else if (entry.isDirectory()) {
      into.set(rel, "dir");
      await walk(path, rel, into);
    } else {
      into.set(rel, await sha256Hex(await fs.readFile(path)));
    }
  }
}
