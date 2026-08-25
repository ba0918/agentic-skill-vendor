import { LOCK_FILE, renderExpectedLock } from "../contracts/manifest.ts";
import type { LockSources } from "../contracts/lock-model.ts";
import type { Declaration } from "../contracts/sources.ts";
import { ConfigError } from "../errors.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { compareStrings } from "../ordering.ts";
import { emptyRecord } from "../records.ts";
import {
  locateTreeContracts,
  type TreeState,
} from "../distribution/tree-materials.ts";
import type { RemoteSnapshot } from "./remote.ts";

export interface SourceResolutionPlan {
  sources: LockSources;
}

export function resolvedReport(
  name: string,
  before: string | undefined,
  revision: string,
): string | null {
  if (before === revision) return null;
  return before === undefined
    ? `resolved: ${name} ${revision} (initial resolution)`
    : `resolved: ${name} ${before} -> ${revision}`;
}

export function resolveSources(
  snapshots: Map<string, RemoteSnapshot>,
  declaration: Declaration,
): SourceResolutionPlan {
  const sources: LockSources = emptyRecord();
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    const source = declaration.sources[name];
    const snapshot = snapshots.get(name);
    if (snapshot === undefined) {
      throw new ConfigError(`no snapshot was opened for the source ${name}`);
    }
    const revision = snapshot.revision;
    sources[name] = {
      repository: source.repository,
      revision,
      ...(snapshot.objectFormat === "sha256"
        ? { objectFormat: "sha256" as const }
        : {}),
    };
  }
  return { sources };
}

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
