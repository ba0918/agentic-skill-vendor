import type { GitObjectFormat } from "./digest.ts";

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
