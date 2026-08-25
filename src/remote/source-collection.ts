import { cacheRevisionDirOf } from "../contracts/cache.ts";
import { declaredIds } from "../contracts/declaration.ts";
import {
  contractPath,
  gitObjectIdOf,
  type GitObjectFormat,
} from "../contracts/digest.ts";
import type { LockSource, LockSources } from "../contracts/lock-model.ts";
import { MARKER_FILE, srcKeyOf } from "../contracts/raw.ts";
import { withContractMapping } from "../contracts/source-edit.ts";
import {
  isTreeRelativePath,
  parseDeclaration,
} from "../contracts/source-schema.ts";
import {
  DECLARATION_FILE,
  originPathOf,
  readDeclarationText,
  type Declaration,
  type RawMapping,
} from "../contracts/sources.ts";
import type { TreeState } from "../distribution/tree-materials.ts";
import { ConfigError } from "../errors.ts";
import type { PlacedFile } from "../filesystem/atomic-write.ts";
import { IGNORE_FILE } from "../filesystem/ignore.ts";
import { dirNameOf, isRegularFileOrAbsent } from "../filesystem/walk.ts";
import { compareStrings } from "../ordering.ts";
import type { CachedRevision } from "./cache-write.ts";
import {
  requireOrdinaryFile,
  type RemoteSnapshot,
  type TreeBlob,
} from "./remote.ts";
import { contractsOf } from "./snapshot-plan.ts";

export interface MappingPlan {
  declaration: Declaration;
  text: string | null;
  report: string[];
}

export async function mapDeclaredContracts(
  root: string,
  snapshots: Map<string, RemoteSnapshot>,
  state: TreeState,
  declarationText: string | null,
): Promise<MappingPlan> {
  const unchanged = {
    declaration: state.declaration,
    text: declarationText,
    report: [],
  };
  const unmapped = declaredIds(state.skills).filter(
    (id) => state.declaration.contracts[id] === undefined,
  );
  if (unmapped.length === 0) return unchanged;

  const unlocated: string[] = [];
  const listings = new Map<string, string[]>();
  for (const name of Object.keys(state.declaration.sources).sort(
    compareStrings,
  )) {
    const snapshot = snapshots.get(name);
    if (snapshot === undefined) continue;
    listings.set(
      name,
      snapshot.blobs.map((entry) => entry.path),
    );
  }
  let text = declarationText ?? (await readDeclarationText(root)) ?? "";
  const before = text;
  const report: string[] = [];
  for (const id of unmapped) {
    if (await isRegularFileOrAbsent(root, contractPath(id))) continue;
    const holders = [...listings]
      .filter(([, paths]) => paths.includes(contractPath(id)))
      .map(([name]) => name);
    if (holders.length === 0) {
      unlocated.push(
        `unlocated: ${id} (no canonical text at any conventional location)`,
      );
      continue;
    }
    if (holders.length > 1) {
      throw new ConfigError(
        `${holders.join(" and ")} both hold ${contractPath(id)}; write the ` +
          `contracts.${id} line in ${DECLARATION_FILE} to say which one ` +
          `${id} comes from`,
      );
    }
    text = withContractMapping(text, id, holders[0]);
    report.push(`mapped: ${id} <- ${holders[0]}`);
  }
  if (text === before) return { ...unchanged, report: unlocated };
  return {
    declaration: parseDeclaration(text),
    text,
    report: [...report, ...unlocated],
  };
}

export async function collectSources(
  snapshots: Map<string, RemoteSnapshot>,
  declaration: Declaration,
  sources: LockSources,
): Promise<CachedRevision[]> {
  const revisions: CachedRevision[] = [];
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    const contracts = contractsOf(declaration, name);
    if (contracts.length === 0) continue;
    const pinned = sources[name];
    if (pinned === undefined) {
      throw new ConfigError(
        `${DECLARATION_FILE} registers the source ${name} but the lock records no commit for it; run update to resolve one`,
      );
    }
    const snapshot = snapshots.get(name);
    if (snapshot === undefined) {
      throw new ConfigError(`no snapshot was opened for the source ${name}`);
    }
    requirePinnedSnapshot(snapshot, pinned, name);
    const files: PlacedFile[] = [];
    for (const id of contracts) {
      const origin = declaration.contracts[id];
      if (origin.files !== undefined) {
        for (const mapping of origin.files) {
          files.push(
            ...(await collectRawMapping(
              snapshot,
              pinned,
              snapshot.blobs,
              id,
              mapping,
            )),
          );
        }
      } else {
        files.push(
          ...(await collectContract(
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

function requirePinnedSnapshot(
  snapshot: RemoteSnapshot,
  pinned: LockSource,
  name: string,
): void {
  const expectedFormat: GitObjectFormat = pinned.objectFormat ?? "sha1";
  if (
    snapshot.revision === pinned.revision &&
    snapshot.objectFormat === expectedFormat
  ) {
    return;
  }
  throw new ConfigError(
    `the snapshot opened for ${name} is ${snapshot.objectFormat}:` +
      `${snapshot.revision}, but the lock pins ${expectedFormat}:` +
      `${pinned.revision}; nothing was written`,
  );
}

async function collectContract(
  snapshot: RemoteSnapshot,
  pinned: LockSource,
  listing: TreeBlob[],
  id: string,
  path: string,
  source: string,
): Promise<PlacedFile[]> {
  const listed = listing.find((entry) => entry.path === path);
  if (listed === undefined) {
    throw new ConfigError(
      `${pinned.repository} does not hold ${path} at the commit the lock ` +
        `pins ${source} to; ${DECLARATION_FILE} maps ${id} to it. Run update ` +
        `to move the pin, or edit the path to one the commit holds`,
    );
  }
  const files: PlacedFile[] = [
    { path, content: await fetchChecked(snapshot, pinned, listed) },
  ];
  const beside = `${dirNameOf(path)}/${id}`;
  const conformance = `${beside}/conformance`;
  const enclosing = listing.find((entry) => entry.path === beside);
  if (enclosing !== undefined) {
    const named = atCommit(pinned, beside);
    requireTreeRelativePath(enclosing, named);
    requireNothingHidingTheTests(enclosing, named);
  }
  const mounted = listing.find((entry) => entry.path === conformance);
  if (mounted !== undefined) {
    const named = atCommit(pinned, conformance);
    requireTreeRelativePath(mounted, named);
    requireOrdinaryFile(mounted, named);
  }
  for (const entry of listing
    .filter((candidate) => candidate.path.startsWith(`${conformance}/`))
    .sort((a, b) => compareStrings(a.path, b.path))) {
    files.push({
      path: entry.path,
      content: await fetchChecked(snapshot, pinned, entry),
    });
  }
  return files;
}

async function collectRawMapping(
  snapshot: RemoteSnapshot,
  pinned: LockSource,
  listing: TreeBlob[],
  id: string,
  mapping: RawMapping,
): Promise<PlacedFile[]> {
  const entries =
    mapping.kind === "file"
      ? listing.filter((entry) => entry.path === mapping.src)
      : listing.filter((entry) => entry.path.startsWith(`${mapping.src}/`));
  const mounted = listing.find((entry) => entry.path === mapping.src);
  if (mapping.kind === "directory" && mounted !== undefined) {
    requireNothingHidingTheTests(mounted, atCommit(pinned, mapping.src));
  }
  if (entries.length === 0) {
    throw new ConfigError(
      `${pinned.repository} does not hold ${srcKeyOf(mapping)} at the ` +
        `commit the lock pins it to; ${DECLARATION_FILE} maps ${id} to it. ` +
        `Run update to move the pin, or edit the files line to a src the ` +
        `commit holds`,
    );
  }
  const files: PlacedFile[] = [];
  for (const entry of [...entries].sort((a, b) =>
    compareStrings(a.path, b.path),
  )) {
    const inside = entry.path.slice(mapping.src.length + 1);
    if (mapping.kind === "directory") {
      if (inside === IGNORE_FILE || inside.endsWith(`/${IGNORE_FILE}`)) {
        throw new ConfigError(
          `${atCommit(pinned, entry.path)}: a ${IGNORE_FILE} inside a ` +
            `directory ${id} distributes would govern what git tracks in ` +
            `every skill it lands in; edit the files line to a src without ` +
            `one, or have the source move it`,
        );
      }
      if (inside === MARKER_FILE) {
        throw new ConfigError(
          `${atCommit(pinned, entry.path)}: ${MARKER_FILE} at the top of a ` +
            `directory ${id} distributes is the marker gen writes, and a copy ` +
            `carrying one of its own could never verify; edit the files line ` +
            `to a src without one, or have the source move it`,
        );
      }
    }
    files.push({
      path: entry.path,
      content: await fetchChecked(snapshot, pinned, entry),
    });
  }
  return files;
}

function requireTreeRelativePath(blob: TreeBlob, named: string): void {
  if (isTreeRelativePath(blob.path)) return;
  throw new ConfigError(
    `${named}: this path does not stay inside the repository that lists it ` +
      `— an empty segment, a "." or ".." step, or a backslash — and it is ` +
      `joined onto both a request URL and a cache directory under the tree ` +
      `root, so a run that took it would write wherever it points`,
  );
}

const HIDING_MODES = ["120000", "160000"];

function requireNothingHidingTheTests(blob: TreeBlob, named: string): void {
  if (!HIDING_MODES.includes(blob.mode)) return;
  throw new ConfigError(
    `${named}: listed as ${JSON.stringify(blob.mode)}, and nothing under a ` +
      `link or a subproject is listed at the commit at all; the conformance ` +
      `tests beside a contract are taken as the listing gives them, so a ` +
      `tree standing behind this entry would be pinned as absent rather than ` +
      `fetched`,
  );
}

function atCommit(pinned: LockSource, path: string): string {
  return `${pinned.repository}@${pinned.revision.slice(0, 12)}:${path}`;
}

async function fetchChecked(
  snapshot: RemoteSnapshot,
  pinned: LockSource,
  blob: TreeBlob,
): Promise<Uint8Array> {
  const named = atCommit(pinned, blob.path);
  requireTreeRelativePath(blob, named);
  requireOrdinaryFile(blob, named);
  const bytes = await snapshot.fileAt(blob.path);
  const arrived = await gitObjectIdOf(bytes, snapshot.objectFormat);
  if (arrived !== blob.objectId) {
    throw new ConfigError(
      `${named}: the bytes that arrived carry the object id ${arrived}, ` +
        `while the commit lists ${blob.objectId} for that file; nothing was ` +
        `written to the cache. The lock takes no part in this check — run ` +
        `fetch again, and if the file keeps arriving as something else, ` +
        `${pinned.repository} is answering with bytes this commit does not ` +
        `hold`,
    );
  }
  return bytes;
}
