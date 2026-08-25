import { CACHE_DIR } from "../contracts/cache.ts";
import { assertPinnedRepositories } from "../contracts/manifest.ts";
import { type Declaration, DECLARATION_FILE } from "../contracts/sources.ts";
import {
  readTreeState,
  type TreeState,
} from "../distribution/tree-materials.ts";
import type { Sink } from "../errors.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import {
  unignoredWorkDirectoryWarning,
  workDirectoryIsIgnored,
} from "../filesystem/workdir.ts";
import { pruneCache } from "./cache.ts";
import { placeInCache } from "./cache-write.ts";
import {
  resolvedReport,
  resolveSources,
  writeLockSources,
} from "./lock-update.ts";
import type { RemoteClient, RemoteSnapshot } from "./remote.ts";
import {
  fetchRequests,
  type SnapshotRequest,
  updateRequests,
} from "./snapshot-plan.ts";
import { collectSources, mapDeclaredContracts } from "./source-collection.ts";

export async function commandFetch(
  root: string,
  out: Sink,
  client: RemoteClient,
): Promise<number> {
  const state = await readTreeState(root);
  assertPinnedRepositories(state.sources, state.declaration);
  await warnUnlessIgnored(root, out);
  const revisions = await withSnapshots(
    client,
    fetchRequests(state.declaration, state.sources),
    async (snapshots) =>
      await collectSources(snapshots, state.declaration, state.sources),
  );
  await placeInCache(root, revisions);
  await pruneCache(root, state.sources);
  return 0;
}

export async function commandUpdate(
  root: string,
  out: Sink,
  client: RemoteClient,
): Promise<number> {
  const state = await readTreeState(root);
  return await updateTree(root, out, client, state, null);
}

export async function commandUpdateWithDeclaration(
  root: string,
  out: Sink,
  client: RemoteClient,
  declaration: Declaration,
  declarationText: string,
): Promise<number> {
  const state = { ...(await readTreeState(root)), declaration };
  return await updateTree(root, out, client, state, declarationText);
}

async function updateTree(
  root: string,
  out: Sink,
  client: RemoteClient,
  state: TreeState,
  declarationText: string | null,
): Promise<number> {
  await warnUnlessIgnored(root, out);
  const prepared = await withSnapshots(
    client,
    updateRequests(state.declaration),
    async (snapshots) => {
      const resolution = resolveSources(snapshots, state.declaration);
      const mapping = await mapDeclaredContracts(
        root,
        snapshots,
        state,
        declarationText,
      );
      const revisions = await collectSources(
        snapshots,
        mapping.declaration,
        resolution.sources,
      );
      return { resolution, mapping, revisions };
    },
    (name, snapshot) => {
      const line = resolvedReport(
        name,
        state.sources[name]?.revision,
        snapshot.revision,
      );
      if (line !== null) out(line);
    },
  );

  await placeInCache(root, prepared.revisions);
  if (prepared.mapping.text !== null) {
    await atomicWriteFile(
      root,
      DECLARATION_FILE,
      new TextEncoder().encode(prepared.mapping.text),
    );
  }
  await writeLockSources(
    root,
    { ...state, declaration: prepared.mapping.declaration },
    prepared.resolution.sources,
  );
  await pruneCache(root, prepared.resolution.sources);
  for (const line of prepared.mapping.report) {
    out(line);
  }
  return 0;
}

async function withSnapshots<T>(
  client: RemoteClient,
  requests: SnapshotRequest[],
  use: (snapshots: Map<string, RemoteSnapshot>) => Promise<T>,
  opened?: (name: string, snapshot: RemoteSnapshot) => void,
): Promise<T> {
  const snapshots = new Map<string, RemoteSnapshot>();
  let cleanupFailure: unknown;
  const result = await (async () => {
    try {
      for (const request of requests) {
        const snapshot = await client.open(request.repository, request.target);
        snapshots.set(request.name, snapshot);
        opened?.(request.name, snapshot);
      }
      return await use(snapshots);
    } finally {
      for (const snapshot of [...snapshots.values()].reverse()) {
        try {
          await snapshot.close();
        } catch (cause) {
          cleanupFailure ??= cause;
        }
      }
    }
  })();
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result;
}

async function warnUnlessIgnored(root: string, out: Sink): Promise<void> {
  if (await workDirectoryIsIgnored(root, CACHE_DIR)) return;
  out(unignoredWorkDirectoryWarning(CACHE_DIR));
}
