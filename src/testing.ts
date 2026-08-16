import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Drives the CLI in process. The tool is reached through its exported entry
 * point rather than a subprocess so that the suite needs no run permission
 * beyond the read and write the tool itself asks for.
 */
export async function runCli(args: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    (line) => stdout.push(line),
    (line) => stderr.push(line),
  );
  return { code, stdout, stderr };
}

/**
 * The committed clean tree. Tests never mutate it: every case clones it into a
 * temporary directory and edits the clone, so a broken tree never has to be
 * maintained in the repository.
 */
const GOOD_FIXTURE = fileURLToPath(
  new URL("../fixtures/contracts-basic/good", import.meta.url),
);

/** Clones the clean fixture tree and runs `fn` against the clone. */
export async function withGoodTree<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vendor-tree-"));
  try {
    const root = `${dir}/tree`;
    await fs.cp(GOOD_FIXTURE, root, { recursive: true });
    return await fn(root);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Runs `fn` against an empty temporary directory. */
export async function withEmptyDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vendor-scratch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Writes `content` at `path`, creating the parent directories it needs. */
export async function writeFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(path, content);
}

type ErrorClass<E extends Error> = new (...args: never[]) => E;

/**
 * Runs `fn`, requires it to have thrown `kind`, and answers with that error.
 *
 * `expect(fn).toThrow(kind)` checks the class but does not hand the error back,
 * and the cases reaching for this one go on to assert on its message.
 */
export function thrownBy<E extends Error>(
  fn: () => unknown,
  kind: ErrorClass<E>,
): E {
  try {
    fn();
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error(`expected ${kind.name} to be thrown, nothing was`);
}

/** The awaited counterpart of `thrownBy`. */
export async function rejectedBy<E extends Error>(
  fn: () => unknown,
  kind: ErrorClass<E>,
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error(`expected ${kind.name} to be thrown, nothing was`);
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copied rather than cast. Web Crypto asks for bytes backed by a plain
  // ArrayBuffer, while a file read hands back a view that may sit in the
  // runtime's shared pool, and the two are reconciled here by making one — an
  // assertion would silence the difference instead of resolving it.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Maps every entry under `root` to a description of its content: the SHA-256 of
 * a file's bytes, or `symlink:<target>` for a link. Comparing two snapshots is
 * how a test states "this run changed nothing", and links are described rather
 * than followed so that a link swapped for a file still shows up as a change.
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
  const names = (await fs.readdir(dir)).sort((a, b) => (a < b ? -1 : 1));
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
