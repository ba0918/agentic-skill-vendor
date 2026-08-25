import {
  LOCK_FILE,
  renderExpectedLock,
  type LockSources,
} from "../contracts/manifest.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import {
  locateTreeContracts,
  type TreeState,
} from "../distribution/tree-materials.ts";

export async function writeLockSources(
  root: string,
  state: TreeState,
  sources: LockSources,
): Promise<void> {
  const rendered = await renderExpectedLock(
    root,
    state.skills,
    state.resolutions,
    sources,
    await locateTreeContracts(root, state),
    state.declaration,
    state.placements,
  );
  await atomicWriteFile(root, LOCK_FILE, new TextEncoder().encode(rendered));
}
