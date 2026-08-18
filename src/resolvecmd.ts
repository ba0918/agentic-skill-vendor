// resolvecmd.ts — the commands that reach the network, and the one path they
// share.
//
// Three commands touch a network and no others do: `fetch` restores the cache
// the lock already describes, `update` moves the pin and fetches what it now
// names, and `add` registers a source before doing what `update` does. All
// three end in the same place — bytes verified, then written into the cache —
// so that place is written once, here.
//
// Nothing in this module decides what a contract's digest should be. The lock
// says what was adopted and this checks the bytes against it; the one command
// allowed to record a new digest is `gen`, offline, from the canonical text.
// A fetch that recorded what it found would make "the tree adopted this text"
// a claim about whatever the network answered with.

import { cacheIsIgnored, cacheSiteOf, CACHE_DIR, pruneCache } from "./cache.ts";
import { conformanceDigestOfEntries } from "./conformance.ts";
import {
  canonicalBody,
  compareStrings,
  contractPath,
  digestOfText,
} from "./digest.ts";
import { ConfigError, type Sink } from "./errors.ts";
import type { GitHubClient } from "./github.ts";
import {
  LOCK_FILE,
  type LockSource,
  type LockSources,
  renderExpectedLock,
  type Resolutions,
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
  atomicWriteFile,
  decodeUtf8,
  dirNameOf,
  isRegularFileOrAbsent,
  readTextFile,
} from "./walk.ts";
import { locateTreeContracts, readTreeState, type TreeState } from "./gen.ts";
import { declaredIds } from "./declaration.ts";

/** One file on its way into the cache: where it goes, and what it holds. */
interface CachedFile {
  site: string;
  content: Uint8Array;
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
  const files = await collectSources(
    client,
    state.declaration,
    state.sources,
    state.resolutions,
  );
  await placeInCache(root, files);
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
  const declaration = await mapDeclaredContracts(
    root,
    client,
    state,
    resolved,
    out,
  );
  const files = await collectSources(client, declaration, resolved, null);
  await placeInCache(root, files);
  await writeLockSources(root, state, resolved);
  await pruneCache(root, resolved);
  return 0;
}

/**
 * Writes a mapping for every declared contract exactly one registered source
 * holds at the conventional position, and reports each line it wrote.
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
 */
async function mapDeclaredContracts(
  root: string,
  client: GitHubClient,
  state: TreeState,
  sources: LockSources,
  out: Sink,
): Promise<Declaration> {
  const unmapped = declaredIds(state.skills).filter(
    (id) => state.declaration.contracts[id] === undefined,
  );
  if (unmapped.length === 0) return state.declaration;
  const listings = new Map<string, string[]>();
  for (const name of Object.keys(state.declaration.sources).sort(
    compareStrings,
  )) {
    const pinned = sources[name];
    if (pinned === undefined) continue;
    listings.set(
      name,
      await client.pathsAt(pinned.repository, pinned.revision),
    );
  }
  let text = await readDeclarationText(root);
  for (const id of unmapped) {
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
    out(`mapped: ${id} <- ${holders[0]}`);
  }
  await atomicWriteFile(root, DECLARATION_FILE, new TextEncoder().encode(text));
  return parseDeclaration(text);
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
 * a state of the tree — the lock names one immutable commit, so bytes that
 * disagree with it mean the fetch or the host is wrong — and that is why it
 * stops the run instead of being reported as a violation.
 */
async function collectSources(
  client: GitHubClient,
  declaration: Declaration,
  sources: LockSources,
  resolutions: Resolutions | null,
): Promise<CachedFile[]> {
  const files: CachedFile[] = [];
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
    const listing = await client.pathsAt(pinned.repository, pinned.revision);
    for (const id of contracts) {
      files.push(
        ...(await collectContract(
          client,
          name,
          pinned,
          listing,
          id,
          originPathOf(id, declaration.contracts[id]),
          resolutions,
        )),
      );
    }
  }
  return files;
}

/** The contract ids one source is the origin of, in a fixed order. */
function contractsOf(declaration: Declaration, source: string): string[] {
  return Object.keys(declaration.contracts)
    .filter((id) => declaration.contracts[id].source === source)
    .sort(compareStrings);
}

/**
 * One contract's canonical text and the conformance tests beside it, fetched
 * and checked against what the lock records for them.
 *
 * A contract the lock says nothing about yet is fetched without a comparison —
 * there is nothing to compare against, and the first digest is recorded by the
 * gen that follows. Everything the lock does name is compared, because the
 * commit is immutable: bytes that disagree with the lock at a pinned commit
 * are not a version that moved, they are an answer that should not have been
 * given.
 */
async function collectContract(
  client: GitHubClient,
  source: string,
  pinned: LockSource,
  listing: string[],
  id: string,
  path: string,
  resolutions: Resolutions | null,
): Promise<CachedFile[]> {
  const named = `${pinned.repository}@${pinned.revision.slice(0, 12)}:${path}`;
  if (!listing.includes(path)) {
    throw new ConfigError(
      `${pinned.repository} does not hold ${path} at the commit the lock ` +
        `pins ${source} to; ${DECLARATION_FILE} maps ${id} to it`,
    );
  }
  const bytes = await client.fileAt(pinned.repository, pinned.revision, path);
  const digest = await digestOfText(
    canonicalBody(decodeUtf8(bytes, named), named),
  );
  const recorded = resolutions?.[id];
  if (recorded !== undefined && recorded.digest !== digest) {
    throw new ConfigError(
      `${named} digests to ${digest}, the lock pins ${recorded.digest}; ` +
        `nothing was written to the cache`,
    );
  }
  const files: CachedFile[] = [
    { site: cacheSiteOf(source, pinned.revision, path), content: bytes },
  ];
  const conformance = `${dirNameOf(path)}/${id}/conformance`;
  const entries: { path: string; content: Uint8Array }[] = [];
  for (const listed of listing
    .filter((candidate) => candidate.startsWith(`${conformance}/`))
    .sort(compareStrings)) {
    const content = await client.fileAt(
      pinned.repository,
      pinned.revision,
      listed,
    );
    entries.push({ path: listed.slice(conformance.length + 1), content });
    files.push({
      site: cacheSiteOf(source, pinned.revision, listed),
      content,
    });
  }
  // The tests are digested as the fetch found them, with none of this tree's
  // own ignore rules applied. The listing this came from holds what the source
  // repository tracks — its own rules already decided that — while this tree's
  // rules exclude the whole cache on purpose, and applying them here would
  // digest every fetched conformance tree as empty.
  const tests =
    entries.length === 0 ? null : await conformanceDigestOfEntries(entries);
  if (recorded !== undefined && (recorded.conformance ?? null) !== tests) {
    throw new ConfigError(
      `the conformance tests of ${id} at the pinned commit digest to ` +
        `${tests ?? "nothing"}, the lock records ${
          recorded.conformance ?? "none"
        }; nothing was written to the cache`,
    );
  }
  return files;
}

/** Writes the checked bytes, each through the guarded atomic write. */
async function placeInCache(root: string, files: CachedFile[]): Promise<void> {
  for (const file of files) {
    await atomicWriteFile(root, file.site, file.content);
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
