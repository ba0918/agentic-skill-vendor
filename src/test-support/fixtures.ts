import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The committed clean tree. Tests never mutate it: every case clones it into a
 * temporary directory and edits the clone, so a broken tree never has to be
 * maintained in the repository.
 */
const GOOD_FIXTURE = fileURLToPath(
  new URL("../../fixtures/contracts-basic/good", import.meta.url),
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

/**
 * The committed tree that takes one contract from another repository, cache
 * and all. Cloned per case for the reason the local one is.
 */
const REMOTE_FIXTURE = fileURLToPath(
  new URL("../../fixtures/contracts-remote/good", import.meta.url),
);

/** Clones the fetched-tree fixture and runs `fn` against the clone. */
export async function withRemoteFixture<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vendor-remote-"));
  try {
    const root = `${dir}/tree`;
    await fs.cp(REMOTE_FIXTURE, root, { recursive: true });
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
