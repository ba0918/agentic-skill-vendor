// github.ts — the only place this tool talks to a network, and the only place
// it says what a well-formed answer looks like.
//
// Two hosts, fixed here and reachable from nothing the tree says: the API that
// resolves a ref to a commit and lists what a commit holds, and the raw content
// host that serves one file at a commit. A declaration that could name a host
// would turn a contract mapping into a way of pointing this tool at any server.
// No redirect is followed either — a chain that was allowed to continue would
// leave the fixed hosts true of its first request only.
//
// Nothing here opens a connection by itself. The transport is handed in as a
// function, so every test drives the real request-building and the real
// response-judging with a fetch that answers from memory — and a test that
// reached the network would be testing GitHub's uptime rather than this code.
//
// Fetching per file is what makes this module small enough to be worth writing
// at all. An archive would mean a tar and a gzip reader — two established
// formats this project refuses to hand-implement — where three URLs and a
// schema check will do.

import { ConfigError, describeCause } from "./errors.ts";
import { concatBytes } from "./digest.ts";
import { isTreeRelativePath } from "./sources.ts";

/** The API host, and the host serving file content at a commit. */
const API_HOST = "https://api.github.com";
const RAW_HOST = "https://raw.githubusercontent.com";

/**
 * A path built from tree-supplied text, one segment at a time.
 *
 * The separators a ref legitimately carries survive, and everything else is
 * encoded: `release/2.x` names the branch it looks like, while a segment
 * carrying anything the URL grammar would read as structure cannot reach the
 * request as structure. The values are already checked against an allowlist
 * before they get here — this is the second of the two, kept because the cost
 * is one function call and the failure it guards against is a request sent
 * somewhere nobody named.
 */
function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

/** The repository itself: what the default branch is read from. */
export function repositoryUrl(repository: string): string {
  return `${API_HOST}/repos/${encodePath(repository)}`;
}

/** The commit a ref names right now. */
export function commitUrl(repository: string, ref: string): string {
  return `${API_HOST}/repos/${encodePath(repository)}/commits/${encodePath(
    ref,
  )}`;
}

/** Everything one commit holds, in one listing. */
export function treeUrl(repository: string, revision: string): string {
  return `${API_HOST}/repos/${encodePath(
    repository,
  )}/git/trees/${encodePath(revision)}?recursive=1`;
}

/** One file's bytes at one commit. */
export function rawUrl(
  repository: string,
  revision: string,
  path: string,
): string {
  return `${RAW_HOST}/${encodePath(repository)}/${encodePath(
    revision,
  )}/${encodePath(path)}`;
}

/**
 * One ordinary file a commit holds: where it sits, and the object id the
 * commit's own listing gives for its bytes.
 *
 * The id travels with the path because the two are one answer. Asked for
 * separately, the pair could describe two different commits, and the check a
 * download is judged against would be judging it against the wrong one.
 */
export interface TreeBlob {
  path: string;
  objectId: string;
}

/**
 * What a run may ask of the network, and nothing else.
 *
 * Four questions, each with one URL behind it. Everything above this interface
 * — which contracts to look for, what to do with the bytes — is decided
 * offline, so the network is never asked anything that depends on what an
 * earlier answer contained.
 */
export interface GitHubClient {
  /** The branch a repository hands out when a ref is not named. */
  defaultBranchOf(repository: string): Promise<string>;
  /** The commit a ref names right now, as a 40-digit SHA. */
  commitOf(repository: string, ref: string): Promise<string>;
  /** Every file one commit holds, each with the id the commit gives it. */
  blobsAt(repository: string, revision: string): Promise<TreeBlob[]>;
  /** One file's bytes at one commit. */
  fileAt(
    repository: string,
    revision: string,
    path: string,
  ): Promise<Uint8Array>;
}

/**
 * A git object id: what a commit is named by, and what a listing gives for
 * every file it names. One form for both, because a commit SHA is an object id
 * — two constants of the same shape would be two places to keep in step.
 */
const OBJECT_ID_FORM = /^[0-9a-f]{40}$/;

/**
 * The modes a listing may name, and the one it names a directory with.
 *
 * An ordinary file is all this tool fetches. A symlink arriving from upstream
 * would be written into the cache as an ordinary file whose content is the
 * path it points at — the tool refuses a link on every path it reads or writes
 * locally, and one coming over the wire must not slip past that by changing
 * shape. A submodule is not a file at all.
 *
 * Judged by mode rather than by the listing's `type`, because the mode is what
 * distinguishes a symlink from a file: both are listed as blobs.
 */
const FILE_MODES = ["100644", "100755"];
const DIRECTORY_MODE = "040000";

/**
 * How much of an answer this tool is willing to read.
 *
 * The scale this design stands on is "a few shared documents, text only", and
 * a limit is what makes that assumption something the run enforces rather than
 * something it hopes for. The two differ because they answer different
 * questions: one file is a document a person wrote, while a listing covers
 * every file in a repository and grows with the repository rather than with
 * the contract.
 *
 * The count is of bytes actually taken off the wire, not of what a header
 * claimed. A length header is written by the same party as the body.
 */
const FILE_LIMIT = 1024 * 1024;
const LISTING_LIMIT = 8 * 1024 * 1024;

/** The client over one transport. The transport is the only injected part. */
export function gitHubOver(transport: typeof fetch): GitHubClient {
  return {
    async commitOf(repository, ref) {
      const url = commitUrl(repository, ref);
      const document = requireObject(await readJson(transport, url), url);
      const sha = document["sha"];
      if (typeof sha !== "string" || !OBJECT_ID_FORM.test(sha)) {
        throw new ConfigError(
          `${url}: answered with no commit SHA, found ${JSON.stringify(sha)}`,
        );
      }
      return sha;
    },
    async defaultBranchOf(repository) {
      const url = repositoryUrl(repository);
      const document = requireObject(await readJson(transport, url), url);
      const branch = document["default_branch"];
      if (typeof branch !== "string" || branch === "") {
        throw new ConfigError(
          `${url}: answered with no default branch, found ${JSON.stringify(
            branch,
          )}`,
        );
      }
      return branch;
    },
    async blobsAt(repository, revision) {
      const url = treeUrl(repository, revision);
      const document = requireObject(await readJson(transport, url), url);
      // A listing the service cut short looks exactly like a repository
      // holding fewer files. Read as complete, a contract's conformance tests
      // would be pinned as absent and the tree would verify clean against a
      // pin that had lost them.
      if (document["truncated"] === true) {
        throw new ConfigError(
          `${url}: answered with a truncated listing; this repository holds ` +
            `more files than one listing can carry`,
        );
      }
      const entries = document["tree"];
      if (!Array.isArray(entries)) {
        throw new ConfigError(
          `${url}: answered with no tree listing, found ${JSON.stringify(
            entries,
          )}`,
        );
      }
      const blobs: TreeBlob[] = [];
      for (const entry of entries) {
        const listed = requireObject(entry, url);
        // Only the files. A directory entry answers neither of the two
        // questions this listing exists to answer offline — whether a source
        // holds a contract, and which files its conformance tree carries.
        const mode = listed["mode"];
        if (mode === DIRECTORY_MODE) continue;
        const path = listed["path"];
        if (typeof path !== "string") {
          throw new ConfigError(
            `${url}: listed a file with no path, found ${JSON.stringify(path)}`,
          );
        }
        // Every path here is joined onto a cache directory under the tree root
        // and onto a request URL, so one that walks upward has the fetch write
        // wherever it points — outside the tree, on the exit code of a clean
        // run. The shape is judged where the answer arrives rather than at each
        // place it is used: a listing is the one input to this tool nobody in
        // the consuming repository reviews.
        //
        // Left out of the listing instead, the entry would be as good as
        // absent, and a host answering with a path a repository cannot hold is
        // exactly the thing worth stopping over.
        if (!isTreeRelativePath(path)) {
          throw new ConfigError(
            `${url}: listed ${JSON.stringify(path)}, which is not a path ` +
              `inside the repository it lists`,
          );
        }
        // Refused rather than passed over. Leaving the entry out would read
        // exactly like a source that does not hold the file — and a
        // conformance test dropped that way is pinned as absent while upstream
        // has it, which the tree then verifies clean against.
        if (typeof mode !== "string" || !FILE_MODES.includes(mode)) {
          throw new ConfigError(
            `${url}: listed ${JSON.stringify(path)} as ${JSON.stringify(
              mode,
            )}, and only an ordinary file (${FILE_MODES.join(" or ")}) is ` +
              `fetched`,
          );
        }
        const objectId = listed["sha"];
        // The id is what every one of this file's bytes is judged against, so
        // an answer that omits it or spells it as something other than an
        // object id is refused rather than carried as an empty acceptance
        // test. Read as "no id to check against", the fetch would keep whatever
        // arrived — which is the check being absent exactly where a host is
        // already behaving oddly.
        if (typeof objectId !== "string" || !OBJECT_ID_FORM.test(objectId)) {
          throw new ConfigError(
            `${url}: listed ${JSON.stringify(path)} with no object id, ` +
              `found ${JSON.stringify(objectId)}`,
          );
        }
        blobs.push({ path, objectId });
      }
      return blobs;
    },
    async fileAt(repository, revision, path) {
      return await request(
        transport,
        rawUrl(repository, revision, path),
        FILE_LIMIT,
      );
    },
  };
}

/** The JSON one request answers with, refused where the answer is not one. */
async function readJson(
  transport: typeof fetch,
  url: string,
): Promise<unknown> {
  const text = new TextDecoder().decode(
    await request(transport, url, LISTING_LIMIT),
  );
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(
      `${url}: answered with unreadable JSON: ${describeCause(cause)}`,
    );
  }
}

/**
 * The bytes one request answers with.
 *
 * A failed request is a refusal rather than an empty answer: a run that read a
 * 404 as "this repository holds no such contract" would report a closure gap
 * about a repository it never successfully reached.
 */
async function request(
  transport: typeof fetch,
  url: string,
  limit: number,
): Promise<Uint8Array> {
  let response: Response;
  try {
    // The redirect is asked for rather than left to the default, and that is
    // the half that closes the hole: followed, the chain would be walked by
    // the runtime and only its last answer would ever reach the check below.
    response = await transport(url, { redirect: "manual" });
  } catch (cause) {
    throw new ConfigError(`cannot reach ${url}: ${describeCause(cause)}`);
  }
  // A redirect is refused rather than followed. The two hosts are fixed here,
  // and following one would make that a statement about the first request of a
  // chain alone: a Location naming any third-party host would be asked next
  // and whatever it answered would be read as the source's own bytes.
  if (response.status >= 300 && response.status < 400) {
    throw new ConfigError(
      `${url}: answered ${response.status}, redirecting to ` +
        `${JSON.stringify(response.headers.get("location"))}; this tool ` +
        `talks to two fixed hosts and follows no redirect, and these ` +
        `endpoints do not normally answer with one`,
    );
  }
  if (!response.ok) {
    // The rate limit is named where it applies. Every request this tool makes
    // is unauthenticated, so the one refusal a person will actually meet is
    // the hourly allowance, and "answered 403" alone sends them looking for a
    // permission problem that is not there.
    const limited =
      response.status === 403 || response.status === 429
        ? "; unauthenticated requests to this host are rate limited by the hour"
        : "";
    throw new ConfigError(`${url}: answered ${response.status}${limited}`);
  }
  return await readCapped(response, url, limit);
}

/**
 * The body, read in the chunks it arrives in and stopped the moment it grows
 * past what the run is willing to hold.
 *
 * Buffered whole and measured afterwards, the limit would be a statement about
 * what the tool accepts rather than about what it reads: a host willing to
 * stream without end would have the run out of memory before the check was
 * ever reached.
 */
async function readCapped(
  response: Response,
  url: string,
  limit: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        throw new ConfigError(
          `${url}: answered with more than ${limit} bytes, which is too large ` +
            `for a shared document`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concatBytes(chunks);
}

function requireObject(value: unknown, url: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `${url}: answered with something other than an object`,
    );
  }
  return value as Record<string, unknown>;
}
