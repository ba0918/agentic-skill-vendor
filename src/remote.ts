import type { GitObjectFormat } from "./digest.ts";
import { ConfigError } from "./errors.ts";
import { classifyRepository } from "./repository.ts";

export interface TreeBlob {
  path: string;
  mode: string;
  objectId: string;
}

/**
 * The modes this tool takes a file at.
 *
 * An ordinary file is all this tool fetches. A symlink arriving from upstream
 * would be written into the cache as an ordinary file whose content is the
 * path it points at — the tool refuses a link on every path it reads or writes
 * locally, and one coming over a remote transport must not slip past that by
 * changing shape. A submodule is not a file at all.
 *
 * Judged by mode rather than by a transport's listing type, because the mode
 * is what distinguishes a symlink from a file: both are listed as blobs.
 */
const FILE_MODES = ["100644", "100755"];

/**
 * Refuses an entry a run is about to take unless it is an ordinary file,
 * named by the caller as the file it was going to take.
 *
 * Refused rather than passed over. Leaving the entry out reads exactly like a
 * source that does not hold the file, and a conformance test dropped that way
 * is pinned as absent while upstream has it — which the tree then verifies
 * clean against.
 *
 * Asked of one file at a time rather than of a whole listing, because a
 * listing covers a whole repository. A link the run never reads cannot be
 * mistaken for an absent file, while refusing over one made a documentation
 * shortcut or a vendored subproject anywhere in a source enough to put every
 * contract that source holds out of reach.
 *
 * Kept beside TreeBlob: placing mode validation in one transport adapter
 * would make every neutral snapshot consumer depend on that concrete adapter.
 */
export function requireOrdinaryFile(blob: TreeBlob, named: string): void {
  if (FILE_MODES.includes(blob.mode)) return;
  throw new ConfigError(
    `${named}: listed as ${JSON.stringify(blob.mode)}, and only an ordinary ` +
      `file (${FILE_MODES.join(" or ")}) is taken; a link or a subproject ` +
      `standing where this tool reads a file is refused rather than left out, ` +
      `since a file left out reads as one the source does not hold`,
  );
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
