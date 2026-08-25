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
import { concatBytes } from "./contracts/digest.ts";
import { isUsableRef } from "./contracts/sources.ts";
import type {
  RemoteClient,
  RemoteSnapshot,
  SnapshotTarget,
  TreeBlob,
} from "./remote.ts";

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

interface GitHubOperations {
  /** The branch a repository hands out when a ref is not named. */
  defaultBranchOf(repository: string): Promise<string>;
  /** The commit a ref names right now, as a 40-digit SHA. */
  commitOf(repository: string, ref: string): Promise<string>;
  /**
   * Everything one commit holds but its directories, each with the mode and
   * the id the commit gives it.
   */
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

/**
 * The client over one transport.
 *
 * The transport is injected so that every test drives the real
 * request-building and the real response-judging without a network. The token
 * is optional and travels no further than the header this builds: it is read
 * from standard input at the command boundary, held for the length of one run,
 * written nowhere, and named by no refusal. Absent — which is every run that
 * did not ask for it — the requests are byte for byte the unauthenticated ones
 * this tool has always made.
 */
export function gitHubOver(
  transport: typeof fetch,
  token?: string,
): RemoteClient {
  const operations: GitHubOperations = {
    async commitOf(repository, ref) {
      const url = commitUrl(repository, ref);
      const document = requireObject(
        await readJson(transport, url, token),
        url,
      );
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
      const document = requireObject(
        await readJson(transport, url, token),
        url,
      );
      const branch = document["default_branch"];
      // Held to the shape a ref read out of the declaration is held to. This
      // value is written into that same table as an unquoted scalar, so a name
      // carrying a line break puts lines of its own into the document and one
      // opening with a comment character reads as no value at all — a table
      // this tool wrote and the tree then lives with.
      if (typeof branch !== "string" || !isUsableRef(branch)) {
        throw new ConfigError(
          `${url}: answered with a default branch this tool cannot record, ` +
            `found ${JSON.stringify(branch)}`,
        );
      }
      return branch;
    },
    async blobsAt(repository, revision) {
      const url = treeUrl(repository, revision);
      const document = requireObject(
        await readJson(transport, url, token),
        url,
      );
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
        // The path is reported, not judged, for the reason the mode below is.
        // A path that walks upward has the fetch write wherever it points, and
        // a path spelled in a shape that means one thing per platform cannot be
        // vouched for — but both are facts about a path this run consumes, and
        // a listing covers a whole repository. Judged here, one file a git
        // repository on POSIX legitimately tracks, `tests/fixtures/windows\
        // path.txt` among them, put every contract that source holds out of
        // reach, with a message naming a path no contract had anything to do
        // with. Where the path becomes a request URL or a cache site is where
        // it is refused.
        // The mode is reported, not judged. This listing covers the whole
        // repository, so a mode refused here made one link or one vendored
        // subproject — anywhere in the source, however far from any contract —
        // enough to put every contract that source holds out of reach. What
        // the run is actually about to take is known where it is taken, and
        // that is where the refusal belongs.
        //
        // A mode that is not a string at all is refused all the same, the way
        // a missing path and an object id that is not one are. That is the
        // answer failing to be a tree listing rather than a mode this tool
        // declines to take, and carried on it would leave an entry describing
        // itself as something no caller can judge.
        if (typeof mode !== "string") {
          throw new ConfigError(
            `${url}: listed ${JSON.stringify(path)} with no mode, found ` +
              `${JSON.stringify(mode)}`,
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
        blobs.push({ path, mode, objectId });
      }
      return blobs;
    },
    async fileAt(repository, revision, path) {
      return await request(
        transport,
        rawUrl(repository, revision, path),
        FILE_LIMIT,
        token,
      );
    },
  };
  return {
    defaultBranchOf: operations.defaultBranchOf,
    async open(
      repository: string,
      target: SnapshotTarget,
    ): Promise<RemoteSnapshot> {
      const revision =
        target.kind === "ref"
          ? await operations.commitOf(repository, target.ref)
          : target.revision;
      const blobs = await operations.blobsAt(repository, revision);
      return {
        revision,
        objectFormat: "sha1",
        blobs,
        async fileAt(path) {
          return await operations.fileAt(repository, revision, path);
        },
        async close() {},
      };
    },
  };
}

/** The JSON one request answers with, refused where the answer is not one. */
async function readJson(
  transport: typeof fetch,
  url: string,
  token: string | undefined,
): Promise<unknown> {
  const text = new TextDecoder().decode(
    await request(transport, url, LISTING_LIMIT, token),
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
  token: string | undefined,
): Promise<Uint8Array> {
  let response: Response;
  try {
    // The redirect is asked for rather than left to the default, and that is
    // the half that closes the hole: followed, the chain would be walked by
    // the runtime and only its last answer would ever reach the check below.
    // No header at all where no token was given, rather than an empty one.
    // A credential spelled as nothing reaches the host as neither an
    // authenticated request nor an anonymous one, and the answer to it would
    // be read here as the source not holding what was asked for.
    //
    // The token is judged before it gets here — printable ASCII, no line
    // break — because a header field is terminated by CRLF and a value
    // carrying one puts headers of its own into the request.
    response = await transport(url, {
      redirect: "manual",
      ...(token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
    });
  } catch (cause) {
    if (token !== undefined) {
      throw new ConfigError(
        `cannot reach ${url}: the authenticated request failed before a ` +
          "response arrived; transport details are omitted so they cannot " +
          "repeat the credential",
      );
    }
    throw new ConfigError(`cannot reach ${url}: ${describeCause(cause)}`);
  }
  // A redirect is refused rather than followed. The two hosts are fixed here,
  // and following one would make that a statement about the first request of a
  // chain alone: a Location naming any third-party host would be asked next
  // and whatever it answered would be read as the source's own bytes.
  if (response.status >= 300 && response.status < 400) {
    const destination =
      token === undefined
        ? `, redirecting to ${JSON.stringify(response.headers.get("location"))}`
        : ", redirecting to a location omitted because an authenticated " +
          "response can repeat the credential there";
    throw new ConfigError(
      `${url}: answered ${response.status}${destination}; this tool ` +
        `talks to two fixed hosts and follows no redirect, and these ` +
        `endpoints do not normally answer with one`,
    );
  }
  if (!response.ok) {
    const refused = refusalNote(response.status, token !== undefined);
    throw new ConfigError(`${url}: answered ${response.status}${refused}`);
  }
  return await readCapped(response, url, limit);
}

/**
 * The likeliest cause of a refused request, named as a cause rather than as
 * the cause.
 *
 * Unauthenticated, the hourly allowance is the refusal a person will usually
 * have met, and "answered 403" alone sends them looking for a permission
 * problem that is not there. It is not the only thing that answers that way:
 * anything standing between the run and the host — a proxy, an egress filter —
 * refuses with the same status, and a message that named the rate limit
 * outright sent a reader to wait out an allowance that was never spent.
 *
 * Authenticated, 401 and 404 point first to a credential that cannot reach the
 * repository or has expired. The 404 belongs in the same note because the raw
 * content host answers it for a credential it cannot validate even where the
 * file is public. A 403 or 429 may instead be an authenticated rate limit, so
 * that possibility stays visible beside credential and traffic-filter causes.
 * The run refuses every one of them rather than reading a failed request as
 * "the source holds no such file"; this line says where to look without
 * pretending one cause is certain.
 */
function refusalNote(status: number, authenticated: boolean): string {
  if (!authenticated) {
    return status === 403 || status === 429
      ? "; unauthenticated requests to this host are rate limited by the " +
          "hour, and anything filtering outbound traffic answers the same way"
      : "";
  }
  if (![401, 403, 404, 429].includes(status)) return "";
  const rateLimit =
    status === 403 || status === 429
      ? "; an authenticated GitHub rate limit may also be exhausted"
      : "";
  return (
    "; the token this run was given may not reach this repository or may " +
    "have expired — the raw content host answers 404 to a credential it " +
    "cannot use, even for a file it would serve without one — and anything " +
    "filtering outbound traffic answers the same way" +
    rateLimit
  );
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
            `for a file a contract distributes`,
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
