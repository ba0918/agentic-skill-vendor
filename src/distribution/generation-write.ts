import * as fs from "node:fs/promises";
import { ConfigError, describeCause, type Sink } from "../errors.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { assertPlainChain, displayName } from "../filesystem/walk.ts";
import { TOOL_DIR } from "../contracts/source-schema.ts";
import {
  unignoredWorkDirectoryWarning,
  workDirectoryIsIgnored,
} from "../filesystem/workdir.ts";
import { placeViaStaging, prepareStaging } from "./staging.ts";
import type { WritePlan } from "./generation-plan.ts";

export async function executePlan(
  root: string,
  plan: WritePlan,
  out: Sink = () => {},
): Promise<void> {
  for (const file of plan.files)
    await atomicWriteFile(root, file.site, file.content);
  if (plan.placed.length > 0 || plan.sweeps.length > 0) {
    if (!(await workDirectoryIsIgnored(root, TOOL_DIR)))
      out(unignoredWorkDirectoryWarning(TOOL_DIR));
  }
  if (plan.placed.length > 0) await prepareStaging(root);
  for (const dest of plan.placed)
    await placeViaStaging(root, dest.site, dest.what);
  const swept = await removeEach(root, plan.sweeps);
  if (swept !== null) throw swept;
  await atomicWriteFile(root, plan.lock.site, plan.lock.content);
  const failed = await removeEach(root, plan.removals);
  if (failed !== null) throw failed;
}

async function removeEach(
  root: string,
  sites: string[],
): Promise<ConfigError | null> {
  const failures: { site: string; cause: unknown }[] = [];
  for (const site of sites) {
    try {
      await assertPlainChain(root, site);
      await fs.rm(`${root}/${site}`, { recursive: true, force: true });
    } catch (cause) {
      failures.push({ site, cause });
    }
  }
  if (failures.length === 0) return null;
  const [first] = failures;
  return new ConfigError(
    `cannot remove ${displayName(first.site)}: ${describeCause(first.cause)}`,
  );
}
