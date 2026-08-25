// staging.ts — building a dest under the tool's own directory and moving it
// into the skill with one rename.
//
// The sibling temporaries the other writes use cannot be used inside a skill:
// a skill's directory is the person's, and a name like `<dest>.tmp` standing
// there is theirs until the gate says otherwise — and the gate never looks at
// that name. So a raw-byte dest is built here, under `.agentic-skill-vendor/`,
// and renamed across. A rename is atomic within one file system only, which
// is why the device is checked before the old dest is removed.

import * as fs from "node:fs/promises";
import { ConfigError, describeCause } from "../errors.ts";
import { TOOL_DIR } from "../contracts/source-schema.ts";
import {
  assertPlainChain,
  dirNameOf,
  displayName,
  ensureParentDirectory,
  kindAt,
  type PlacedFile,
} from "../filesystem/walk.ts";

export const STAGING_DIR = `${TOOL_DIR}/staging`;

/**
 * Clears what an earlier run left in the staging directory and makes it
 * ready. The chain down to it is refused for links first: the clearing is
 * recursive, and a link at `.agentic-skill-vendor/` itself would send it
 * outside the tree.
 */
export async function prepareStaging(root: string): Promise<void> {
  await assertPlainChain(root, STAGING_DIR);
  try {
    await fs.rm(`${root}/${STAGING_DIR}`, { recursive: true, force: true });
    await fs.mkdir(`${root}/${STAGING_DIR}`, { recursive: true });
  } catch (cause) {
    throw new ConfigError(
      `cannot prepare ${displayName(STAGING_DIR)}: ${describeCause(cause)}`,
    );
  }
}

let counter = 0;

type DeviceOf = (path: string) => Promise<number>;

async function deviceOf(path: string): Promise<number> {
  return (await fs.stat(path)).dev;
}

/**
 * Places `files` at `relative` as a whole directory, or `content` as one
 * file, via the staging directory. What stands at `relative` is removed
 * first — the caller's gate has already confirmed it is this tool's.
 */
export async function placeViaStaging(
  root: string,
  relative: string,
  what: { files: PlacedFile[] } | { content: Uint8Array },
  readDevice: DeviceOf = deviceOf,
): Promise<void> {
  const staged = `${STAGING_DIR}/${counter++}`;
  const stagedPath = `${root}/${staged}`;
  const path = `${root}/${relative}`;
  await assertPlainChain(root, dirNameOf(relative));
  await ensureParentDirectory(root, relative);
  try {
    if ("files" in what) {
      for (const file of what.files) {
        const site = `${stagedPath}/${file.path}`;
        await fs.mkdir(dirNameOf(site), { recursive: true });
        await fs.writeFile(site, file.content);
      }
    } else {
      await fs.writeFile(stagedPath, what.content);
    }
    await assertSameDevice(root, staged, dirNameOf(relative), readDevice);
    if ((await kindAt(root, relative)) !== null) {
      await fs.rm(path, { recursive: true });
    }
    await fs.rename(stagedPath, path);
  } catch (cause) {
    await fs.rm(stagedPath, { recursive: true, force: true }).catch(() => {});
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `cannot write ${displayName(relative)}: ${describeCause(cause)}`,
    );
  }
}

/**
 * Refuses, before anything is removed, a dest whose parent sits on another
 * file system than the staging directory: the rename would fail after the
 * old dest was gone.
 */
async function assertSameDevice(
  root: string,
  staged: string,
  parent: string,
  readDevice: DeviceOf,
): Promise<void> {
  const [a, b] = await Promise.all([
    readDevice(`${root}/${staged}`),
    readDevice(`${root}/${parent}`),
  ]);
  if (a === b) return;
  throw new ConfigError(
    `${displayName(parent)} and ${displayName(STAGING_DIR)} are on different ` +
      `file systems, so a dest cannot be moved into place atomically; keep ` +
      `${displayName(TOOL_DIR)} on the file system the skills are on`,
  );
}
