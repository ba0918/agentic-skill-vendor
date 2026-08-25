import type { GitObjectFormat } from "./digest.ts";
import { classifyRepository } from "./repository.ts";

export interface TreeBlob {
  path: string;
  mode: string;
  objectId: string;
}

export type SnapshotTarget =
  | { kind: "ref"; ref: string }
  | {
      kind: "pin";
      revision: string;
      objectFormat: GitObjectFormat;
      ref?: string;
    };

export interface RemoteSnapshot {
  revision: string;
  objectFormat: GitObjectFormat;
  blobs: TreeBlob[];
  fileAt(path: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface RemoteClient {
  defaultBranchOf(repository: string): Promise<string>;
  open(repository: string, target: SnapshotTarget): Promise<RemoteSnapshot>;
}

export type RemoteClientFactory = () => Promise<RemoteClient>;

export function routedRemoteClient(factories: {
  github: RemoteClientFactory;
  git: RemoteClientFactory;
}): RemoteClient {
  const clients = new Map<"github" | "git", Promise<RemoteClient>>();
  const clientFor = (repository: string): Promise<RemoteClient> => {
    const kind = classifyRepository(repository).kind;
    const existing = clients.get(kind);
    if (existing !== undefined) return existing;
    const client = factories[kind]();
    clients.set(kind, client);
    return client;
  };
  return {
    async defaultBranchOf(repository) {
      return await (await clientFor(repository)).defaultBranchOf(repository);
    },
    async open(repository, target) {
      return await (await clientFor(repository)).open(repository, target);
    },
  };
}
