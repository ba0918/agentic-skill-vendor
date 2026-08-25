import * as fs from "node:fs/promises";

const LOCK_FILE = "vendor-lock.json";

/**
 * The lock, read and written as arbitrary JSON. The tests address the fields
 * they need by name, and a recursive JSON type would put a cast at every one
 * of those sites for nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: manifests are arbitrary JSON.
export type Json = any;

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

/**
 * The kind word that opens each of a command's output lines.
 *
 * Every line the tool writes is a parseable `kind: detail` line, so a test
 * asserting which findings a command produced reads the kinds. The sort is
 * part of the help here: the tests that assert a set of findings written by a
 * run with nondeterministic ordering state the set, not the order.
 */
export function kindsOf(lines: string[]): string[] {
  return lines.map((line) => line.slice(0, line.indexOf(":"))).sort();
}

/** The lock as read back from disk, as the shape tests hand to the tool. */
export async function readLockFile(root: string): Promise<Json> {
  return JSON.parse(await fs.readFile(`${root}/${LOCK_FILE}`, "utf8"));
}

/** Writes `lock` as the tree's lock file, in the canonical rendering. */
export async function writeLockFile(root: string, lock: Json): Promise<void> {
  await fs.writeFile(
    `${root}/${LOCK_FILE}`,
    JSON.stringify(lock, null, 2) + "\n",
  );
}
