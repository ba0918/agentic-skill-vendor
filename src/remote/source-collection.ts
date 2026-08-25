import { ConfigError } from "../errors.ts";
import { compareStrings } from "../ordering.ts";
import { cacheRevisionDirOf } from "../contracts/cache.ts";
import {
  DECLARATION_FILE,
  originPathOf,
  type Declaration,
  type RawMapping,
} from "../contracts/source-schema.ts";
import type { LockSource, LockSources } from "../contracts/lock-model.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import type { CachedRevision } from "./cache-write.ts";
import type { RemoteSnapshot, TreeBlob } from "./remote.ts";
import { contractsOf } from "./snapshot-plan.ts";

export interface SourceCollectors {
  assertPinned(
    snapshot: RemoteSnapshot,
    pinned: LockSource,
    name: string,
  ): void;
  collectDocument(
    snapshot: RemoteSnapshot,
    pinned: LockSource,
    listing: TreeBlob[],
    id: string,
    path: string,
    source: string,
  ): Promise<PlacedFile[]>;
  collectRaw(
    snapshot: RemoteSnapshot,
    pinned: LockSource,
    listing: TreeBlob[],
    id: string,
    mapping: RawMapping,
  ): Promise<PlacedFile[]>;
}

export async function collectSources(
  snapshots: Map<string, RemoteSnapshot>,
  declaration: Declaration,
  sources: LockSources,
  collectors: SourceCollectors,
): Promise<CachedRevision[]> {
  const revisions: CachedRevision[] = [];
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    const contracts = contractsOf(declaration, name);
    if (contracts.length === 0) continue;
    const pinned = sources[name];
    if (pinned === undefined)
      throw new ConfigError(
        `${DECLARATION_FILE} registers the source ${name} but the lock records no commit for it; run update to resolve one`,
      );
    const snapshot = snapshots.get(name);
    if (snapshot === undefined)
      throw new ConfigError(`no snapshot was opened for the source ${name}`);
    collectors.assertPinned(snapshot, pinned, name);
    const files: PlacedFile[] = [];
    for (const id of contracts) {
      const origin = declaration.contracts[id];
      if (origin.files !== undefined) {
        for (const mapping of origin.files)
          files.push(
            ...(await collectors.collectRaw(
              snapshot,
              pinned,
              snapshot.blobs,
              id,
              mapping,
            )),
          );
      } else {
        files.push(
          ...(await collectors.collectDocument(
            snapshot,
            pinned,
            snapshot.blobs,
            id,
            originPathOf(id, origin),
            name,
          )),
        );
      }
    }
    revisions.push({ site: cacheRevisionDirOf(name, pinned.revision), files });
  }
  return revisions;
}
