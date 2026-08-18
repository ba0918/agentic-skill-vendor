// resolvecmd.ts — the commands that reach the network, and the one path they
// share.
//
// Three commands touch a network and no others do: `fetch` restores the cache
// the lock already describes, `update` moves the pin and fetches what it now
// names, and `add` registers a source before doing what `update` does. All
// three end in the same place — bytes verified, then written into the cache —
// so that place is written once, here.
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

import {
  cacheIsIgnored,
  cacheRevisionDirOf,
  CACHE_DIR,
  pruneCache,
} from "./cache.ts";
import { compareStrings, contractPath, gitObjectIdOf } from "./digest.ts";
import { ConfigError, type Sink } from "./errors.ts";
import type { GitHubClient, TreeBlob } from "./github.ts";
import {
  LOCK_FILE,
  type LockSource,
  type LockSources,
  renderExpectedLock,
} from "./manifest.ts";
import { emptyRecord } from "./records.ts";
import {
  type Declaration,
  DECLARATION_FILE,
  originPathOf,
  parseDeclaration,
  withContractMapping,
} from "./sources.ts";
import {
  atomicWriteDirectory,
  atomicWriteFile,
  dirNameOf,
  isRegularFileOrAbsent,
  type PlacedFile,
  readTextFile,
} from "./walk.ts";
import { locateTreeContracts, readTreeState, type TreeState } from "./gen.ts";
import { declaredIds } from "./declaration.ts";

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
  client: GitHubClient,
): Promise<number> {
  const state = await readTreeState(root);
  await warnUnlessIgnored(root, out);
  const revisions = await collectSources(
    client,
    state.declaration,
    state.sources,
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
  client: GitHubClient,
): Promise<number> {
  const state = await readTreeState(root);
  await warnUnlessIgnored(root, out);
  const resolved = await resolveSources(
    client,
    state.declaration,
    state.sources,
    out,
  );
  // Nothing is compared against the lock here. Moving the pin is what this
  // command does, so text differing from what the lock records is the ordinary
  // case — the very change being adopted — and refusing over it would make
  // every genuine upstream edit a failure. What the new text is gets recorded
  // by the gen that follows, as an adoption a reviewer reads in the diff.
  const mapping = await mapDeclaredContracts(root, client, state, resolved);
  const revisions = await collectSources(client, mapping.declaration, resolved);
  await placeInCache(root, revisions);
  // The table lands with the bytes it accounts for, the way gen builds its
  // whole plan before writing any of it. Written before the fetch, a source
  // that could not be reached left a table naming an origin for a contract
  // whose text never arrived and a lock still pinned where it was — a tree
  // describing a state no run ever produced, which a reader has no way to tell
  // from one the tool meant.
  if (mapping.text !== null) {
    await atomicWriteFile(
      root,
      DECLARATION_FILE,
      new TextEncoder().encode(mapping.text),
    );
  }
  // Rendered from the table this run leaves behind, never the one it read: the
  // mapping written a moment ago decides which contracts the lock accounts
  // for, and rendering against the older table would leave a file verify
  // reports as differing from what the tree renders to.
  await writeLockSources(
    root,
    { ...state, declaration: mapping.declaration },
    resolved,
  );
  await pruneCache(root, resolved);
  for (const line of mapping.report) out(line);
  return 0;
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
  client: GitHubClient,
  state: TreeState,
  sources: LockSources,
): Promise<{
  declaration: Declaration;
  text: string | null;
  report: string[];
}> {
  const unchanged = { declaration: state.declaration, text: null, report: [] };
  const unmapped = declaredIds(state.skills).filter(
    (id) => state.declaration.contracts[id] === undefined,
  );
  if (unmapped.length === 0) return unchanged;
  const listings = new Map<string, string[]>();
  for (const name of Object.keys(state.declaration.sources).sort(
    compareStrings,
  )) {
    const pinned = sources[name];
    if (pinned === undefined) continue;
    listings.set(
      name,
      (await client.blobsAt(pinned.repository, pinned.revision)).map(
        (entry) => entry.path,
      ),
    );
  }
  let text = await readDeclarationText(root);
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
    const holders = [...listings]
      .filter(([, paths]) => paths.includes(contractPath(id)))
      .map(([name]) => name);
    if (holders.length === 0) continue;
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
  if (text === before) return unchanged;
  return { declaration: parseDeclaration(text), text, report };
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
async function resolveSources(
  client: GitHubClient,
  declaration: Declaration,
  recorded: LockSources,
  out: Sink,
): Promise<LockSources> {
  const resolved: LockSources = emptyRecord();
  for (const name of Object.keys(declaration.sources).sort(compareStrings)) {
    const source = declaration.sources[name];
    const revision = await client.commitOf(source.repository, source.ref);
    const before = recorded[name]?.revision;
    if (before !== revision) {
      out(
        before === undefined
          ? `resolved: ${name} ${revision} (initial resolution)`
          : `resolved: ${name} ${before} -> ${revision}`,
      );
    }
    resolved[name] = { repository: source.repository, revision };
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
  client: GitHubClient,
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
    const listing = await client.blobsAt(pinned.repository, pinned.revision);
    const files: PlacedFile[] = [];
    for (const id of contracts) {
      files.push(
        ...(await collectContract(
          client,
          pinned,
          listing,
          id,
          originPathOf(id, declaration.contracts[id]),
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
 */
async function collectContract(
  client: GitHubClient,
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
        `pins ${source} to; ${DECLARATION_FILE} maps ${id} to it`,
    );
  }
  const files: PlacedFile[] = [
    { path, content: await fetchChecked(client, pinned, listed) },
  ];
  // The tests travel with the text, as the fetch finds them, with none of this
  // tree's own ignore rules applied. The listing holds what the source
  // repository tracks — its own rules already decided that — while this tree's
  // rules exclude the whole cache on purpose, and applying them here would
  // fetch no conformance tree at all.
  const conformance = `${dirNameOf(path)}/${id}/conformance`;
  for (const entry of listing
    .filter((candidate) => candidate.path.startsWith(`${conformance}/`))
    .sort((a, b) => compareStrings(a.path, b.path))) {
    files.push({
      path: entry.path,
      content: await fetchChecked(client, pinned, entry),
    });
  }
  return files;
}

/**
 * One file's bytes, refused unless they hash to the object id the commit's own
 * listing gives for that file.
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
  client: GitHubClient,
  pinned: LockSource,
  blob: TreeBlob,
): Promise<Uint8Array> {
  const bytes = await client.fileAt(
    pinned.repository,
    pinned.revision,
    blob.path,
  );
  const arrived = await gitObjectIdOf(bytes);
  if (arrived !== blob.objectId) {
    const named = `${pinned.repository}@${pinned.revision.slice(0, 12)}:${
      blob.path
    }`;
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
  if (await cacheIsIgnored(root)) return;
  out(
    `warning: ${CACHE_DIR} is not ignored by this repository; add ` +
      `/${CACHE_DIR.split("/")[0]}/ to .gitignore so fetched copies are ` +
      `never committed`,
  );
}
