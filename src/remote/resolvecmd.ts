// resolvecmd.ts — the commands that reach the network, and the one path they
// share.
//
// Three commands touch a network and no others do: `fetch` restores the cache
// the lock already describes, `update` moves the pin and fetches what it now
// names, and `add` prepares a source registration before doing what `update`
// does and publishing both results together. All three end in the same place
// — bytes verified, then written into the cache — so that place is written
// once, here.
//
// Nothing in this module decides what a contract's digest should be. The one
// command allowed to record a digest is `gen`, offline, from the canonical
// text. A fetch that recorded what it found would make "the tree adopted this
// text" a claim about whatever the network answered with.
//
// Nothing here reads the lock's digests either. What a download is judged
// against is the commit it came from — the listing carries an object id for
// every file — so the cache can be rebuilt to match the commit from any state
// the tree is in. Judged against the lock, the checks pointed at each other:
// this refused bytes the lock did not already record, gen rewrote the lock
// from whatever the cache held, and a tree between the two could be moved by
// neither.

import { pruneCache } from "./cache.ts";
import { CACHE_DIR, cacheRevisionDirOf } from "../contracts/cache.ts";
import {
  unignoredWorkDirectoryWarning,
  workDirectoryIsIgnored,
} from "../filesystem/workdir.ts";
import {
  contractPath,
  gitObjectIdOf,
  type GitObjectFormat,
} from "../contracts/digest.ts";
import { compareStrings } from "../ordering.ts";
import { ConfigError, type Sink } from "../errors.ts";
import {
  requireOrdinaryFile,
  type RemoteClient,
  type RemoteSnapshot,
  type SnapshotTarget,
  type TreeBlob,
} from "./remote.ts";
import {
  assertPinnedRepositories,
  LOCK_FILE,
  type LockSource,
  type LockSources,
  renderExpectedLock,
} from "../contracts/manifest.ts";
import { emptyRecord } from "../records.ts";
import { MARKER_FILE, srcKeyOf } from "../contracts/raw.ts";
import { IGNORE_FILE } from "../filesystem/ignore.ts";
import {
  type Declaration,
  DECLARATION_FILE,
  isTreeRelativePath,
  originPathOf,
  parseDeclaration,
  type RawMapping,
  withContractMapping,
} from "../contracts/sources.ts";
import {
  dirNameOf,
  isRegularFileOrAbsent,
  type PlacedFile,
  readTextFile,
} from "../filesystem/walk.ts";
import {
  atomicWriteDirectory,
  atomicWriteFile,
} from "../filesystem/atomic-write.ts";
import {
  locateTreeContracts,
  readTreeState,
  type TreeState,
} from "../distribution/gen.ts";
import { declaredIds } from "../contracts/declaration.ts";

/**
 * One revision on its way into the cache: the directory it is placed at, and
 * every file that directory is to hold.
 *
 * Collected as a whole rather than as loose files, because a whole is what gets
 * placed. A list of files with nothing saying which revision each belongs to
 * would leave the placement deciding it again from the paths.
 */
interface CachedRevision {
  site: string;
  files: PlacedFile[];
}

/**
 * Restores the cache the lock already describes.
 *
 * Reads the lock and writes nothing back to it. That is what makes this the
 * command a clean checkout runs: the pin was decided when the version was
 * adopted, reviewed in the diff it landed in, and this run reproduces it
 * rather than deciding it again.
 */
export async function commandFetch(
  root: string,
  out: Sink,
  client: RemoteClient,
): Promise<number> {
  const state = await readTreeState(root);
  // Asked before the first request goes out. This command takes bytes from the
  // repository the pin names, so a pin the table does not register would send
  // the whole run to a repository the tree says elsewhere it does not use.
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

/**
 * Moves each source's pin to the commit its ref names now, and reports the
 * move.
 *
 * The one command that decides which version a tree adopts. Everything else is
 * downstream of the line it writes into the lock: the fetch that fills the
 * cache reproduces it, and the gen that records digests reads what it left
 * behind.
 */
export async function commandUpdate(
  root: string,
  out: Sink,
  client: RemoteClient,
): Promise<number> {
  const state = await readTreeState(root);
  return await updateTree(root, out, client, state, null);
}

/**
 * Updates through a source table prepared by `add`, without publishing that
 * table before its repository has been acquired and verified.
 */
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
      const resolved = resolveSources(
        snapshots,
        state.declaration,
        state.sources,
        out,
      );
      // Nothing is compared against the lock here. Moving the pin is what this
      // command does, so text differing from what the lock records is the ordinary
      // case — the very change being adopted — and refusing over it would make
      // every genuine upstream edit a failure. What the new text is gets recorded
      // by the gen that follows, as an adoption a reviewer reads in the diff.
      const mapping = await mapDeclaredContracts(
        root,
        snapshots,
        state,
        declarationText,
      );
      const revisions = await collectSources(
        snapshots,
        mapping.declaration,
        resolved,
      );
      return { resolved, mapping, revisions };
    },
  );
  await placeInCache(root, prepared.revisions);
  // The table lands with the bytes it accounts for, the way gen builds its
  // whole plan before writing any of it. Written before the fetch, a source
  // that could not be reached left a table naming an origin for a contract
  // whose text never arrived and a lock still pinned where it was — a tree
  // describing a state no run ever produced, which a reader has no way to tell
  // from one the tool meant.
  if (prepared.mapping.text !== null) {
    await atomicWriteFile(
      root,
      DECLARATION_FILE,
      new TextEncoder().encode(prepared.mapping.text),
    );
  }
  // Rendered from the table this run leaves behind, never the one it read: the
  // mapping written a moment ago decides which contracts the lock accounts
  // for, and rendering against the older table would leave a file verify
  // reports as differing from what the tree renders to.
  await writeLockSources(
    root,
    { ...state, declaration: prepared.mapping.declaration },
    prepared.resolved,
  );
  await pruneCache(root, prepared.resolved);
  for (const line of prepared.mapping.report) out(line);
  return 0;
}

interface SnapshotRequest {
  name: string;
  repository: string;
  target: SnapshotTarget;
}

function updateRequests(declaration: Declaration): SnapshotRequest[] {
  return Object.keys(declaration.sources)
    .sort(compareStrings)
    .map((name) => {
      const source = declaration.sources[name];
      return {
        name,
        repository: source.repository,
        target: { kind: "ref" as const, ref: source.ref },
      };
    });
}

function fetchRequests(
  declaration: Declaration,
  sources: LockSources,
): SnapshotRequest[] {
  const requests: SnapshotRequest[] = [];
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    if (contractsOf(declaration, name).length === 0) continue;
    const pinned = sources[name];
    if (pinned === undefined) {
      throw new ConfigError(
        `${DECLARATION_FILE} registers the source ${name} but the lock ` +
          `records no commit for it; run update to resolve one`,
      );
    }
    requests.push({
      name,
      repository: pinned.repository,
      target: {
        kind: "pin",
        revision: pinned.revision,
        objectFormat: pinned.objectFormat ?? "sha1",
        ref: declaration.sources[name].ref,
      },
    });
  }
  return requests;
}

async function withSnapshots<T>(
  client: RemoteClient,
  requests: SnapshotRequest[],
  use: (snapshots: Map<string, RemoteSnapshot>) => Promise<T>,
): Promise<T> {
  const snapshots = new Map<string, RemoteSnapshot>();
  let cleanupFailure: unknown;
  const result = await (async () => {
    try {
      for (const request of requests) {
        snapshots.set(
          request.name,
          await client.open(request.repository, request.target),
        );
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
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
  return result;
}

/**
 * A mapping for every declared contract exactly one registered source holds at
 * the conventional position: the revised table, its text, and the line each
 * mapping is reported as.
 *
 * The one thing a person writes is the id in a skill. Which source holds it is
 * a question that can be answered by looking, so it is answered by looking —
 * and the answer is written into the table as a line a reviewer reads in the
 * diff, rather than resolved again on every run from whatever the network says
 * that day.
 *
 * Only the conventional position is searched. A canonical text kept anywhere
 * else is a decision nothing here can infer, so those lines stay the person's
 * to write, and a line already written is never second-guessed: an explicit
 * mapping is itself the adjudication this search would otherwise have to make.
 *
 * The text is handed back rather than written, and the report with it, so both
 * land with everything else the run produces or with none of it. Reported from
 * here, a line would announce a mapping the run then failed to write.
 */
async function mapDeclaredContracts(
  root: string,
  snapshots: Map<string, RemoteSnapshot>,
  state: TreeState,
  declarationText: string | null,
): Promise<{
  declaration: Declaration;
  text: string | null;
  report: string[];
}> {
  const unchanged = {
    declaration: state.declaration,
    text: declarationText,
    report: [],
  };
  const unmapped = declaredIds(state.skills).filter(
    (id) => state.declaration.contracts[id] === undefined,
  );
  if (unmapped.length === 0) return unchanged;
  // The ids this search finds nowhere, reported whether or not the table
  // changes: a raw-byte contract has no conventional position, so the line
  // that says "write a files row" is the one thing this run can say about it.
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
  let text = declarationText ?? (await readDeclarationText(root));
  const before = text;
  const report: string[] = [];
  for (const id of unmapped) {
    // A canonical text in this repository settles the question before any
    // source is looked at, which is the order the derivation is defined in.
    // Searched first, registering a source that happens to carry the same id
    // would move the authority over an existing contract to another
    // repository, with no line anywhere saying it happened — and it would not
    // even be caught by the refusal below, since one holder is not ambiguous.
    // The line itself is written by gen, offline, where the file either is
    // there or is not.
    if (await isRegularFileOrAbsent(root, contractPath(id))) continue;
    // Which source holds the contract is answered by what stands at the
    // conventional position, whatever mode it stands there in. A link counted
    // here becomes a mapping whose fetch then refuses it — in this same run,
    // before the table is written, naming the path and the mode. Left out
    // instead, a source that does hold the file at that path would read
    // exactly like one holding nothing there, and the run would end on "no
    // source holds this contract" about a source that does.
    const holders = [...listings]
      .filter(([, paths]) => paths.includes(contractPath(id)))
      .map(([name]) => name);
    if (holders.length === 0) {
      unlocated.push(
        `unlocated: ${id} (no canonical text at any conventional location)`,
      );
      continue;
    }
    // Letting one of them win quietly is how a document ends up maintained in
    // two places with nothing recording which copy the tree distributes. The
    // refusal is the moment that duplication becomes visible, and writing the
    // line by hand is the decision it asks for.
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
  // A search that found nothing to write down leaves the file alone, rather
  // than handing back what it read. Written unconditionally, a tree that keeps
  // no table at all — every repository whose contracts are all its own — got
  // one holding no document, which this tool's own reader refuses: one update
  // and every later gen and verify stopped on a file that update had made.
  if (text === before) return { ...unchanged, report: unlocated };
  return {
    declaration: parseDeclaration(text),
    text,
    report: [...report, ...unlocated],
  };
}

/** The declaration as it stands, or an empty document where there is none. */
async function readDeclarationText(root: string): Promise<string> {
  if (!(await isRegularFileOrAbsent(root, DECLARATION_FILE))) return "";
  return await readTextFile(`${root}/${DECLARATION_FILE}`, DECLARATION_FILE);
}

/**
 * Each registered source's ref, resolved to the commit it names right now.
 *
 * Reported one line per source, in the shape the lock's own diff carries: a
 * reviewer reads which version moved from where to where without having to
 * open the file, and a first resolution says so rather than showing an empty
 * left-hand side.
 */
function resolveSources(
  snapshots: Map<string, RemoteSnapshot>,
  declaration: Declaration,
  recorded: LockSources,
  out: Sink,
): LockSources {
  const resolved: LockSources = emptyRecord();
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    const source = declaration.sources[name];
    const snapshot = snapshots.get(name);
    if (snapshot === undefined) {
      throw new ConfigError(`no snapshot was opened for the source ${name}`);
    }
    const revision = snapshot.revision;
    const before = recorded[name]?.revision;
    if (before !== revision) {
      out(
        before === undefined
          ? `resolved: ${name} ${revision} (initial resolution)`
          : `resolved: ${name} ${before} -> ${revision}`,
      );
    }
    resolved[name] = {
      repository: source.repository,
      revision,
      ...(snapshot.objectFormat === "sha256"
        ? { objectFormat: "sha256" as const }
        : {}),
    };
  }
  return resolved;
}

/**
 * Writes the lock with the pins this run resolved, through the same rendering
 * gen and verify compare against.
 *
 * Rendered any other way, the file this leaves behind would be reported as
 * differing from what the tree renders to — a violation raised by the command
 * that had just put the tree right.
 */
async function writeLockSources(
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

/**
 * Every file the declaration's remote contracts need, fetched and checked
 * before any of it is written.
 *
 * Checked first and written afterwards for the reason gen builds its whole
 * plan before writing it: a run stopped part way must not leave a cache half
 * filled with bytes nothing has vouched for. What a mismatch means here is not
 * a state of the tree — the commit is immutable and says what each of its
 * files hashes to — and that is why it stops the run instead of being reported
 * as a violation.
 */
async function collectSources(
  snapshots: Map<string, RemoteSnapshot>,
  declaration: Declaration,
  sources: LockSources,
): Promise<CachedRevision[]> {
  const revisions: CachedRevision[] = [];
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    const contracts = contractsOf(declaration, name);
    if (contracts.length === 0) continue;
    const pinned = sources[name];
    // Nothing here can decide which commit that would be. Resolving a ref is
    // what update does, and doing it quietly on the way past would adopt a
    // version nobody reviewed — the one thing the split between the two
    // commands exists to prevent.
    if (pinned === undefined) {
      throw new ConfigError(
        `${DECLARATION_FILE} registers the source ${name} but the lock ` +
          `records no commit for it; run update to resolve one`,
      );
    }
    const snapshot = snapshots.get(name);
    if (snapshot === undefined) {
      throw new ConfigError(`no snapshot was opened for the source ${name}`);
    }
    requirePinnedSnapshot(snapshot, pinned, name);
    const listing = snapshot.blobs;
    const files: PlacedFile[] = [];
    for (const id of contracts) {
      const origin = declaration.contracts[id];
      if (origin.files !== undefined) {
        for (const mapping of origin.files) {
          files.push(
            ...(await collectRawMapping(
              snapshot,
              pinned,
              listing,
              id,
              mapping,
            )),
          );
        }
        continue;
      }
      files.push(
        ...(await collectContract(
          snapshot,
          pinned,
          listing,
          id,
          originPathOf(id, origin),
          name,
        )),
      );
    }
    revisions.push({
      site: cacheRevisionDirOf(name, pinned.revision),
      files,
    });
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

/** The contract ids one source is the origin of, in a fixed order. */
function contractsOf(declaration: Declaration, source: string): string[] {
  return Object.keys(declaration.contracts)
    .filter((id) => declaration.contracts[id].source === source)
    .sort(compareStrings);
}

/**
 * One contract's canonical text and the conformance tests beside it, fetched
 * and checked against the ids the commit itself gives them.
 *
 * The listing decides what is taken: the contract at its mapped path, and
 * every file under the conformance directory beside it. Both come from the one
 * answer that also carries their object ids, so what lands in the cache is
 * what the pinned commit holds — a fact established without the lock, which
 * records adoption rather than what a transfer is allowed to be.
 *
 * That selection, together with the two positions the tests can stand hidden
 * behind — the conformance directory itself, and the directory it sits in —
 * is the whole range an entry's mode is judged over. Everything else a listing
 * names is passed over whatever its mode: a file no run opens cannot be
 * dropped and read back afterwards as one upstream does not hold, and judging
 * the listing as a whole put every contract a source holds out of reach over
 * one link standing anywhere in it.
 */
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
  // The tests travel with the text, as the fetch finds them, with none of this
  // tree's own ignore rules applied. The listing holds what the source
  // repository tracks — its own rules already decided that — while this tree's
  // rules exclude the whole cache on purpose, and applying them here would
  // fetch no conformance tree at all.
  const beside = `${dirNameOf(path)}/${id}`;
  const conformance = `${beside}/conformance`;
  const enclosing = listing.find((entry) => entry.path === beside);
  if (enclosing !== undefined) {
    const named = atCommit(pinned, beside);
    requireTreeRelativePath(enclosing, named);
    requireNothingHidingTheTests(enclosing, named);
  }
  // An entry standing at the conformance directory itself is judged too,
  // though nothing is ever taken from it. A directory never reaches this
  // listing, so a path listed here is the tests mounted through a link or a
  // subproject — and passed over, that reads as a contract carrying no tests
  // at all, which is the state the whole check exists to keep out of a pin.
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

/**
 * The files one raw-byte mapping takes from a commit: the one file at a file
 * src, or everything under a directory src, selected by separator-terminated
 * prefix so `tools/rt/` never takes `tools/rt-old/`.
 *
 * A src the commit does not hold stops the run, and the refusal names what
 * moves the tree on — a new pin, or a different src — never a fetch, which
 * would only arrive back here. The two names refused inside a local directory
 * src are refused here too, before anything reaches the cache, and an entry
 * standing at the directory src's own position in a hiding mode is refused
 * for the reason the conformance position is.
 */
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

/**
 * Refuses an entry whose own path does not stay inside the repository it is
 * listed in, named by the caller as the entry it was consuming.
 *
 * Asked of the entries this run consumes rather than of the whole listing, for
 * the reason the mode is: a listing covers a whole repository, and a git
 * repository on POSIX legitimately tracks a name this tool cannot vouch for —
 * `tests/fixtures/windows\path.txt` is one — so judging the listing put every
 * contract that source holds out of reach over a file no run opens, with a
 * message naming a path no contract had anything to do with.
 *
 * Consumed means fetched, written or judged. An entry that only ever gets
 * compared against a path this run is looking for is none of the three: it
 * reaches no URL and no cache site, and a shape it happens to carry decides
 * nothing. Every path that does reach either passes through here — the
 * canonical text at its mapped path and each conformance file beside it are
 * checked in the one function every fetched byte comes through, so a future
 * caller cannot reach a write without it.
 */
function requireTreeRelativePath(blob: TreeBlob, named: string): void {
  if (isTreeRelativePath(blob.path)) return;
  throw new ConfigError(
    `${named}: this path does not stay inside the repository that lists it ` +
      `— an empty segment, a "." or ".." step, or a backslash — and it is ` +
      `joined onto both a request URL and a cache directory under the tree ` +
      `root, so a run that took it would write wherever it points`,
  );
}

/** The modes a whole subtree can stand hidden behind: a link, a subproject. */
const HIDING_MODES = ["120000", "160000"];

/**
 * Refuses an entry standing where the conformance tree's own directory would
 * be, in one of the modes that hide whatever is under it.
 *
 * A link and a subproject are each a single blob, and nothing beneath a blob
 * is listed at all: the tests a source keeps under one never reach the refusal
 * that guards the conformance position itself, and the run pins the contract
 * as carrying no tests while the source has them. That is the confusion that
 * refusal exists to prevent, occurring one level above where it looks.
 *
 * An ordinary file standing there is passed over rather than refused, which is
 * why the two modes are named instead of every mode but a file's. A tree
 * cannot hold anything under a path a blob already occupies, so "this contract
 * has no conformance tests" is a fact about the source rather than something
 * this run dropped, and refusing would stop every run over a source that is
 * simply shaped that way. A directory at that place is the ordinary case, and
 * never reaches this listing.
 */
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

/** One file of one commit, named the way a refusal about it reads. */
function atCommit(pinned: LockSource, path: string): string {
  return `${pinned.repository}@${pinned.revision.slice(0, 12)}:${path}`;
}

/**
 * One file's bytes, refused unless the commit lists it as an ordinary file and
 * they hash to the object id that same listing gives for it.
 *
 * The mode and the shape of the path are judged here rather than where the
 * listing arrives, and that is what keeps both judgments over the files this
 * run takes and no others: every file that reaches the cache comes through this
 * function, while a listing covers a whole repository. The path is judged
 * before the request goes out, since this one value becomes the request URL and
 * the cache site alike.
 *
 * The acceptance test is the source commit, never the lock. A commit is
 * immutable and names what each of its files hashes to, so "the cache holds
 * what this commit holds" is something a fetch can establish by itself — which
 * is what lets it rebuild the cache from any state the tree is in.
 *
 * A mismatch is a transfer that went wrong or a source answering with
 * something the commit does not hold, so the run stops and writes nothing. The
 * message says so, because the wording it replaced accused the host in a state
 * the tool itself had produced: a lock and a cache that had drifted apart left
 * fetch refusing bytes that were perfectly good.
 */
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

/**
 * Places each revision's checked bytes, one guarded move per revision.
 *
 * Written file by file, a run stopped part way left a revision directory
 * holding whichever files had arrived first — and every later command reads a
 * directory standing at that place as a revision that was taken up whole.
 */
async function placeInCache(
  root: string,
  revisions: CachedRevision[],
): Promise<void> {
  for (const revision of revisions) {
    await atomicWriteDirectory(root, revision.site, revision.files);
  }
}

/**
 * Warns where the tree does not keep the cache out of the repository.
 *
 * A warning rather than a refusal: a committed cache is a second copy of every
 * fetched contract standing beside the vendored ones — a file a later reader
 * edits believing it is canonical — but it is a fact about the repository's
 * configuration, and a fetch that refused over it would leave the tree unable
 * to build at all.
 */
async function warnUnlessIgnored(root: string, out: Sink): Promise<void> {
  if (await workDirectoryIsIgnored(root, CACHE_DIR)) return;
  out(unignoredWorkDirectoryWarning(CACHE_DIR));
}
