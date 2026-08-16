import { copy } from "@std/fs";
import { run } from "./vendor.ts";

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
const GOOD_FIXTURE = new URL(
  "../fixtures/contracts-basic/good",
  import.meta.url,
).pathname;

/** Clones the clean fixture tree and runs `fn` against the clone. */
export async function withGoodTree<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "vendor-tree-" });
  try {
    const root = `${dir}/tree`;
    await copy(GOOD_FIXTURE, root);
    return await fn(root);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Runs `fn` against an empty temporary directory. */
export async function withEmptyDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "vendor-scratch-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Writes `content` at `path`, creating the parent directories it needs. */
export async function writeFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  if (typeof content === "string") {
    await Deno.writeTextFile(path, content);
  } else {
    await Deno.writeFile(path, content);
  }
}

/** Replaces `path` with a symlink to `target`. */
export async function replaceWithSymlink(
  path: string,
  target: string,
): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch(() => {});
  const parent = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  await Deno.symlink(target, path);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
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
export async function snapshotTree(
  root: string,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  await walk(root, "", snapshot);
  return snapshot;
}

async function walk(
  dir: string,
  prefix: string,
  into: Map<string, string>,
): Promise<void> {
  const entries = [...Deno.readDirSync(dir)].sort((a, b) =>
    a.name < b.name ? -1 : 1
  );
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymlink) {
      into.set(rel, `symlink:${await Deno.readLink(path)}`);
    } else if (entry.isDirectory) {
      into.set(rel, "dir");
      await walk(path, rel, into);
    } else {
      into.set(rel, await sha256Hex(await Deno.readFile(path)));
    }
  }
}
