import { concatBytes, type GitObjectFormat } from "./contracts/digest.ts";
import { ConfigError } from "./errors.ts";
import type {
  GitProcessCommand,
  GitProcessRunner,
  GitProcessSession,
  GitSourceBudget,
} from "./gitprocess.ts";
import type {
  RemoteClient,
  RemoteSnapshot,
  SnapshotTarget,
  TreeBlob,
} from "./remote.ts";
import { isUsableRef } from "./contracts/sources.ts";

const METADATA_LIMIT = 1024 * 1024;
const FILE_LIMIT = 1024 * 1024;
const SHA1_OBJECT_ID = /^[0-9a-f]{40}$/;
const SHA256_OBJECT_ID = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function gitOver(
  runner: GitProcessRunner,
  options: { interactive: boolean },
): RemoteClient {
  const pendingBudgets = new Map<string, GitSourceBudget>();
  return {
    async defaultBranchOf(repository) {
      const budget = runner.createBudget();
      const session = await runner.begin({ ...options, budget });
      let branch: string;
      try {
        const output = await session.run(
          command(
            "external",
            ["ls-remote", "--symref", repository, "HEAD"],
            "ref resolution",
          ),
        );
        branch = defaultBranchFrom(output);
      } finally {
        await session.close();
      }
      pendingBudgets.set(repository, budget);
      return branch;
    },
    async open(repository, target) {
      const budget = pendingBudgets.get(repository) ?? runner.createBudget();
      pendingBudgets.delete(repository);
      const session = await runner.begin({ ...options, budget });
      try {
        return await openSnapshot(session, repository, target);
      } catch (cause) {
        await session.close().catch(() => {});
        throw cause;
      }
    },
  };
}

async function openSnapshot(
  session: GitProcessSession,
  repository: string,
  target: SnapshotTarget,
): Promise<RemoteSnapshot> {
  const objectFormat =
    target.kind === "pin"
      ? target.objectFormat
      : objectFormatOf(
          firstObjectId(
            await session.run(
              command(
                "external",
                ["ls-remote", repository, target.ref],
                "ref resolution",
              ),
            ),
            "ref resolution",
          ),
        );
  await session.initialize(objectFormat);
  await configureRemote(session, repository);
  if (target.kind === "ref") {
    await fetch(session, target.ref);
  } else {
    await fetchPin(session, target);
  }
  const revision = firstObjectId(
    await session.run(
      command(
        "repository",
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        "object verification",
      ),
    ),
    "object verification",
  );
  requireObjectFormat(revision, objectFormat, "fetched commit");
  if (target.kind === "pin" && revision !== target.revision) {
    throw new ConfigError(
      `same-ref fallback fetched a different commit (${revision}) than the lock pins (${target.revision}); nothing was accepted`,
    );
  }
  const blobs = await readTree(session, revision, objectFormat);
  return {
    revision,
    objectFormat,
    blobs,
    async fileAt(path) {
      const chunks: Uint8Array[] = [];
      await session.stream(
        {
          kind: "repository",
          args: ["cat-file", "blob", `${revision}:${path}`],
          stage: "object verification",
          account: "extraction",
          outputLimit: FILE_LIMIT,
        },
        (chunk) => {
          const copy = new Uint8Array(chunk.length);
          copy.set(chunk);
          chunks.push(copy);
        },
      );
      return concatBytes(chunks);
    },
    async close() {
      await session.close();
    },
  };
}

async function fetch(
  session: GitProcessSession,
  target: string,
): Promise<void> {
  await session.run(
    command(
      "repository",
      [
        "fetch",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        target,
      ],
      "commit fetch",
    ),
  );
}

async function configureRemote(
  session: GitProcessSession,
  repository: string,
): Promise<void> {
  await session.run(
    command(
      "repository",
      ["remote", "add", "--no-tags", "origin", repository],
      "connection or authentication",
    ),
  );
  await session.run(
    command(
      "repository",
      ["config", "remote.origin.promisor", "true"],
      "connection or authentication",
    ),
  );
  await session.run(
    command(
      "repository",
      ["config", "remote.origin.partialclonefilter", "blob:none"],
      "connection or authentication",
    ),
  );
}

async function fetchPin(
  session: GitProcessSession,
  target: Extract<SnapshotTarget, { kind: "pin" }>,
): Promise<void> {
  try {
    await fetch(session, target.revision);
  } catch (exactFailure) {
    if (target.ref === undefined) throw exactFailure;
    try {
      await fetch(session, target.ref);
    } catch {
      throw exactFailure;
    }
  }
}

function command(
  kind: GitProcessCommand["kind"],
  args: readonly string[],
  stage: GitProcessCommand["stage"],
): GitProcessCommand {
  return {
    kind,
    args,
    stage,
    account: "metadata",
    outputLimit: METADATA_LIMIT,
  };
}

function defaultBranchFrom(bytes: Uint8Array): string {
  const text = decode(bytes, "ref resolution");
  const line = text
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith("ref: refs/heads/") &&
        candidate.endsWith("\tHEAD"),
    );
  const branch = line?.slice("ref: refs/heads/".length, -"\tHEAD".length);
  if (branch === undefined || !isUsableRef(branch)) {
    throw new ConfigError(
      "ref resolution failed: the remote HEAD did not name a recordable default branch",
    );
  }
  return branch;
}

function firstObjectId(bytes: Uint8Array, stage: string): string {
  const objectId = decode(bytes, stage).trim().split(/\s/, 1)[0] ?? "";
  if (!SHA1_OBJECT_ID.test(objectId) && !SHA256_OBJECT_ID.test(objectId)) {
    throw new ConfigError(
      `${stage} failed: Git answered with no valid object id`,
    );
  }
  return objectId;
}

function objectFormatOf(objectId: string): GitObjectFormat {
  return objectId.length === 40 ? "sha1" : "sha256";
}

function requireObjectFormat(
  objectId: string,
  objectFormat: GitObjectFormat,
  site: string,
): void {
  const valid =
    objectFormat === "sha1"
      ? SHA1_OBJECT_ID.test(objectId)
      : SHA256_OBJECT_ID.test(objectId);
  if (!valid) {
    throw new ConfigError(
      `object verification failed: ${site} is not a ${objectFormat} object id`,
    );
  }
}

async function readTree(
  session: GitProcessSession,
  revision: string,
  objectFormat: GitObjectFormat,
): Promise<TreeBlob[]> {
  const parser = new TreeStreamParser(objectFormat);
  await session.stream(
    {
      kind: "repository",
      args: [
        "ls-tree",
        "-rz",
        "--full-tree",
        "--format=%(objectmode) %(objectname) %(path)",
        revision,
      ],
      stage: "object verification",
      account: "metadata",
    },
    (chunk) => parser.push(chunk),
  );
  return parser.finish();
}

class TreeStreamParser {
  readonly #blobs: TreeBlob[] = [];
  readonly #objectFormat: GitObjectFormat;
  #pending = new Uint8Array();

  constructor(objectFormat: GitObjectFormat) {
    this.#objectFormat = objectFormat;
  }

  push(chunk: Uint8Array): void {
    const bytes = concatBytes([this.#pending, chunk]);
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0) continue;
      this.#take(bytes.subarray(start, index));
      start = index + 1;
    }
    this.#pending = new Uint8Array(bytes.subarray(start));
  }

  finish(): TreeBlob[] {
    if (this.#pending.length !== 0) {
      throw new ConfigError(
        "object verification failed: Git returned an unterminated tree entry",
      );
    }
    return this.#blobs;
  }

  #take(entry: Uint8Array): void {
    if (entry.length === 0) return;
    const first = entry.indexOf(0x20);
    const second = entry.indexOf(0x20, first + 1);
    if (first <= 0 || second <= first + 1) {
      throw new ConfigError(
        "object verification failed: Git returned an unreadable tree entry",
      );
    }
    const mode = decode(entry.subarray(0, first), "object verification");
    const objectId = decode(
      entry.subarray(first + 1, second),
      "object verification",
    );
    const path = decode(entry.subarray(second + 1), "object verification");
    requireObjectFormat(
      objectId,
      this.#objectFormat,
      `tree entry ${JSON.stringify(path)} object id`,
    );
    this.#blobs.push({ mode, objectId, path });
  }
}

function decode(bytes: Uint8Array, stage: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ConfigError(
      `${stage} failed: Git returned text that is not valid UTF-8`,
    );
  }
}
