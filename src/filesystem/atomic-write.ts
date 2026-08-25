import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { ConfigError, describeCause } from "../errors.ts";
import {
  TEMPORARY_SUFFIX,
  assertPlainChain,
  dirNameOf,
  displayName,
  ensureParentDirectory,
  kindAt,
} from "./walk.ts";

function isNotFound(cause: unknown): boolean {
  return (cause as { code?: string } | null)?.code === "ENOENT";
}

export async function atomicWriteFile(
  root: string,
  relative: string,
  content: Uint8Array,
): Promise<void> {
  const path = `${root}/${relative}`;
  const temporary = `${path}${TEMPORARY_SUFFIX}`;
  await assertPlainChain(root, dirNameOf(relative));
  await ensureParentDirectory(root, relative);
  await assertWritableTarget(temporary, `${relative}${TEMPORARY_SUFFIX}`);
  await assertWritableTarget(path, relative);
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, path);
  } catch (cause) {
    await fs.rm(temporary).catch(() => {});
    throw new ConfigError(
      `cannot write ${displayName(relative)}: ${describeCause(cause)}`,
    );
  }
}

export interface PlacedFile {
  path: string;
  content: Uint8Array;
}

export async function atomicWriteDirectory(
  root: string,
  relative: string,
  files: PlacedFile[],
): Promise<void> {
  const path = `${root}/${relative}`;
  const temporary = `${path}${TEMPORARY_SUFFIX}`;
  await assertPlainChain(root, dirNameOf(relative));
  await assertReplaceableDirectory(root, relative);
  await ensureParentDirectory(root, relative);
  try {
    await fs.rm(temporary, { recursive: true, force: true });
    for (const file of files) {
      const site = `${temporary}/${file.path}`;
      await fs.mkdir(dirNameOf(site), { recursive: true });
      await fs.writeFile(site, file.content);
    }
    await fs.rm(path, { recursive: true, force: true });
    await fs.rename(temporary, path);
  } catch (cause) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw new ConfigError(
      `cannot write ${displayName(relative)}: ${describeCause(cause)}`,
    );
  }
}

async function assertReplaceableDirectory(
  root: string,
  relative: string,
): Promise<void> {
  const info = await kindAt(root, relative);
  if (info === null) return;
  if (!info.isDirectory())
    throw new ConfigError(
      `refusing to write over ${displayName(relative)}: not a directory`,
    );
}

async function assertWritableTarget(path: string, site: string): Promise<void> {
  let info: Stats;
  try {
    info = await fs.lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) return;
    throw new ConfigError(
      `cannot inspect ${displayName(site)}: ${describeCause(cause)}`,
    );
  }
  if (info.isSymbolicLink())
    throw new ConfigError(
      `refusing to write through a symlink: ${displayName(site)}`,
    );
  if (!info.isFile())
    throw new ConfigError(
      `refusing to write over ${displayName(site)}: not a regular file`,
    );
}
