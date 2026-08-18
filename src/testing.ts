import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { compareStrings, gitObjectIdOf, sha256Hex } from "./digest.ts";

const LOCK_FILE = "vendor-lock.json";

/**
 * The lock, read and written as arbitrary JSON. The tests address the fields
 * they need by name, and a recursive JSON type would put a cast at every one
 * of those sites for nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: manifests are arbitrary JSON.
export type Json = any;

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Drives the CLI in process. The tool is reached through its exported entry
 * point rather than a subprocess so that the suite needs no run permission
 * beyond the read and write the tool itself asks for.
 *
 * The transport is handed in for the same reason: a case that drove the
 * fetching commands through the real one would be testing GitHub rather than
 * this tool, and the suite would need a network to pass. A case that names no
 * transport gets one that refuses every request, so a command that reached for
 * the network where it must not is a failure rather than a silent connection.
 */
export async function runCli(
  args: string[],
  transport: typeof fetch = refusingTransport,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    (line) => stdout.push(line),
    (line) => stderr.push(line),
    transport,
  );
  return { code, stdout, stderr };
}

const refusingTransport = ((input: string | URL | Request) => {
  throw new Error(`the test suite reaches no network: ${String(input)}`);
}) as unknown as typeof fetch;

/**
 * Every module of this package `entry` reaches, `entry` itself included.
 *
 * What a case built on this states is a boundary — which code an entry point
 * is built on — and the answer has to come from the imports rather than from a
 * list beside them: a list stays true only until the import it should have
 * caught is written, at which point it names one module too few and says
 * nothing at all.
 *
 * The names are read out of the source text rather than imported, so a
 * `import type` edge counts as much as a value one. It is stricter than what
 * the runtime does — a type-only import loads nothing — and deliberately so:
 * an entry point naming the network layer at all is the change worth seeing,
 * whatever the runtime then does with the name.
 */
export async function importClosureOf(entry: string): Promise<Set<string>> {
  const reached = new Set<string>();
  const pending = [entry];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    const source = await fs.readFile(
      new URL(`./${name}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/from "\.\/([\w.-]+\.ts)"/g)) {
      pending.push(match[1]);
    }
  }
  return reached;
}

/**
 * The committed clean tree. Tests never mutate it: every case clones it into a
 * temporary directory and edits the clone, so a broken tree never has to be
 * maintained in the repository.
 */
const GOOD_FIXTURE = fileURLToPath(
  new URL("../fixtures/contracts-basic/good", import.meta.url),
);

/** Clones the clean fixture tree and runs `fn` against the clone. */
export async function withGoodTree<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vendor-tree-"));
  try {
    const root = `${dir}/tree`;
    await fs.cp(GOOD_FIXTURE, root, { recursive: true });
    return await fn(root);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/**
 * The committed tree that takes one contract from another repository, cache
 * and all. Cloned per case for the reason the local one is.
 */
const REMOTE_FIXTURE = fileURLToPath(
  new URL("../fixtures/contracts-remote/good", import.meta.url),
);

/** Clones the fetched-tree fixture and runs `fn` against the clone. */
export async function withRemoteFixture<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vendor-remote-"));
  try {
    const root = `${dir}/tree`;
    await fs.cp(REMOTE_FIXTURE, root, { recursive: true });
    return await fn(root);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Runs `fn` against an empty temporary directory. */
export async function withEmptyDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vendor-scratch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Writes `content` at `path`, creating the parent directories it needs. */
export async function writeFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(path, content);
}

/** Adds `text` to the end of an existing file: an edit the tool must notice. */
export async function append(path: string, text: string): Promise<void> {
  await fs.writeFile(path, (await fs.readFile(path, "utf8")) + text);
}

type ErrorClass<E extends Error> = new (...args: never[]) => E;

/**
 * Runs `fn`, requires it to have thrown `kind`, and answers with that error.
 *
 * `expect(fn).toThrow(kind)` checks the class but does not hand the error back,
 * and the cases reaching for this one go on to assert on its message.
 */
export function thrownBy<E extends Error>(
  fn: () => unknown,
  kind: ErrorClass<E>,
): E {
  try {
    fn();
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error(`expected ${kind.name} to be thrown, nothing was`);
}

/** The awaited counterpart of `thrownBy`. */
export async function rejectedBy<E extends Error>(
  fn: () => unknown,
  kind: ErrorClass<E>,
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error(`expected ${kind.name} to be thrown, nothing was`);
}

/**
 * The uid a runtime would report, or undefined where it has no getuid method.
 *
 * The permission gating below needs one answer on every runtime this package
 * claims to support. A runtime with no `process` global at all — Deno — must
 * not be reached for `process.getuid` directly: reading the global throws a
 * ReferenceError. The helper is handed an environment-like value instead, so
 * the module's own `process` reference stays behind a guard in one place.
 */
export function processUidOf(env: unknown): number | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  const getuid = (env as { getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid() : undefined;
}

/**
 * True where the permission bits a case sets are the ones the run obeys.
 *
 * A process running as root reads through a mode of 000, so a case built on
 * one would assert that a failure was handled while no failure ever happened.
 * Skipping is the honest answer: the behaviour is unobservable here.
 */
export const PERMISSIONS_APPLY =
  processUidOf(typeof process === "undefined" ? undefined : process) !== 0;

/**
 * Runs `fn` while nothing may read `path`, and puts the mode back afterwards.
 *
 * The restore is not tidiness. A directory nobody may read is one the fixture
 * teardown cannot walk either, so leaving it would replace whatever the case
 * asserts with a failure to remove a temporary directory.
 */
export async function withUnreadable<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { mode } = await fs.stat(path);
  await fs.chmod(path, 0o000);
  try {
    return await fn();
  } finally {
    await fs.chmod(path, mode);
  }
}

/**
 * Moves what sits at `relative` out of the tree and leaves a link to it behind.
 * Answers with the directory that now holds the moved content, so a case can
 * state that nothing outside the tree was read through or written to.
 */
export async function escapeThrough(
  root: string,
  relative: string,
): Promise<string> {
  const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
  await fs.mkdir(outside, { recursive: true });
  // The relative path is folded into one file name by replacing its separators.
  // `replaceAll` was once used for that, and it is not injective: `a/b` and
  // `a-b` folded to the same name, so two otherwise distinct escapes could hit
  // the same file. Percent-encoding keeps one relative to one target while
  // staying a legal file name.
  const target = `${outside}/${relative.replaceAll("/", "%2F")}`;
  await fs.rename(`${root}/${relative}`, target);
  await fs.symlink(target, `${root}/${relative}`);
  return outside;
}

/** Replaces `path` with a symlink to `target`. */
export async function replaceWithSymlink(
  path: string,
  target: string,
): Promise<void> {
  await fs.rm(path, { recursive: true }).catch(() => {});
  const parent = path.slice(0, path.lastIndexOf("/"));
  await fs.mkdir(parent, { recursive: true });
  await fs.symlink(target, path);
}

/**
 * Maps every entry under `root` to a description of its content: the SHA-256
 * of a file's bytes, or `symlink:<target>` for a link. Comparing two snapshots
 * is how a test states "this run changed nothing", and links are described
 * rather than followed so that a link swapped for a file still shows up as a
 * change.
 */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  await walk(root, "", snapshot);
  return snapshot;
}

/**
 * The kind word that opens each of a command's output lines.
 *
 * Every line the tool writes is a parseable `kind: detail` line, so a test
 * asserting which findings a command produced reads the kinds. The sort is
 * part of the help here: the tests that assert a set of findings written by a
 * run with nondeterministic ordering state the set, not the order.
 */
export function kindsOf(lines: string[]): string[] {
  return lines.map((line) => line.slice(0, line.indexOf(":"))).sort();
}

/** The lock as read back from disk, as the shape tests hand to the tool. */
export async function readLockFile(root: string): Promise<Json> {
  return JSON.parse(await fs.readFile(`${root}/${LOCK_FILE}`, "utf8"));
}

/** Writes `lock` as the tree's lock file, in the canonical rendering. */
export async function writeLockFile(root: string, lock: Json): Promise<void> {
  await fs.writeFile(
    `${root}/${LOCK_FILE}`,
    JSON.stringify(lock, null, 2) + "\n",
  );
}

async function walk(
  dir: string,
  prefix: string,
  into: Map<string, string>,
): Promise<void> {
  const names = (await fs.readdir(dir)).sort(compareStrings);
  for (const name of names) {
    const path = `${dir}/${name}`;
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    // Each entry is stat'd rather than read off the directory listing: a
    // listing reports an entry's type from the file system's d_type, which
    // some file systems do not fill in, and a symlink that came back as
    // "unknown" would be recorded as an ordinary file.
    const entry = await fs.lstat(path);
    if (entry.isSymbolicLink()) {
      into.set(rel, `symlink:${await fs.readlink(path)}`);
    } else if (entry.isDirectory()) {
      into.set(rel, "dir");
      await walk(path, rel, into);
    } else {
      into.set(rel, await sha256Hex(await fs.readFile(path)));
    }
  }
}

/** One repository as the fake GitHub below serves it. */
export interface FakeRepository {
  defaultBranch: string;
  /** What each ref resolves to: a ref name mapped to a commit SHA. */
  refs: Record<string, string>;
  /** The files each commit holds: a commit SHA mapped to path/content. */
  files: Record<string, Record<string, string>>;
  /**
   * What a path is listed with, where it is not an ordinary file: a path
   * mapped to its git mode. A symlink is `120000` and a submodule `160000`,
   * and the listing's own `type` follows from the mode the way the real
   * service's does.
   */
  modes?: Record<string, string>;
  /** Answers the tree listing as truncated, the way a huge repository does. */
  truncated?: boolean;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  /** Every URL the tool asked for, in order. */
  requested: string[];
}

/**
 * A GitHub that answers from memory, in the shapes the real one answers in.
 *
 * The suite never opens a socket: the transport is injected everywhere it is
 * used, and this is what gets injected. The response bodies carry the fields
 * the real API sends around the ones the tool reads — a fake that answered with
 * only the consumed fields would pass while the tool silently depended on a
 * field the real service spells differently.
 *
 * The tree listing is derived from the files rather than stated beside them, so
 * a case cannot describe a repository that lists a file it does not serve.
 */
export function fakeGitHub(
  repositories: Record<string, FakeRepository>,
): FakeGitHub {
  const requested: string[] = [];
  const transport = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    return await answerFor(url, repositories);
  }) as typeof fetch;
  return { fetch: transport, requested };
}

async function answerFor(
  url: string,
  repositories: Record<string, FakeRepository>,
): Promise<Response> {
  const api = url.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(?:\/(commits|git\/trees)\/(.+?))?(?:\?recursive=1)?$/,
  );
  if (api !== null) {
    const [, name, kind, rest] = api;
    const repository = repositories[name];
    if (repository === undefined) return notFound(name);
    if (kind === undefined) return repositoryResponse(name, repository);
    if (kind === "commits") return commitResponse(repository, rest);
    return await treeResponse(repository, rest);
  }
  const raw = url.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/,
  );
  if (raw !== null) {
    const [, name, revision, path] = raw;
    const content = repositories[name]?.files[revision]?.[path];
    if (content === undefined) return notFound(path);
    return new Response(content, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return notFound(url);
}

function notFound(_named: string): Response {
  return jsonResponse(
    {
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
      status: "404",
    },
    404,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function repositoryResponse(
  name: string,
  repository: FakeRepository,
): Response {
  const [owner, repo] = name.split("/");
  return jsonResponse(
    {
      id: 428957369,
      node_id: "R_kgDOGZ2Q-Q",
      name: repo,
      full_name: name,
      private: false,
      owner: {
        login: owner,
        id: 1904906,
        node_id: "MDQ6VXNlcjE5MDQ5MDY=",
        type: "User",
        site_admin: false,
      },
      html_url: `https://github.com/${name}`,
      description: null,
      fork: false,
      url: `https://api.github.com/repos/${name}`,
      created_at: "2024-11-16T09:00:00Z",
      updated_at: "2026-08-01T09:00:00Z",
      pushed_at: "2026-08-01T09:00:00Z",
      size: 42,
      stargazers_count: 0,
      watchers_count: 0,
      language: "Markdown",
      forks_count: 0,
      open_issues_count: 0,
      license: null,
      topics: [],
      visibility: "public",
      default_branch: repository.defaultBranch,
    },
    200,
  );
}

function commitResponse(repository: FakeRepository, ref: string): Response {
  const sha =
    repository.refs[ref] ?? (ref in repository.files ? ref : undefined);
  if (sha === undefined) return notFound(ref);
  return jsonResponse(
    {
      sha,
      node_id: "C_kwDOGZ2Q-doAKD",
      commit: {
        author: {
          name: "A Committer",
          email: "committer@example.invalid",
          date: "2026-08-01T09:00:00Z",
        },
        committer: {
          name: "A Committer",
          email: "committer@example.invalid",
          date: "2026-08-01T09:00:00Z",
        },
        message: "the commit this ref names",
        tree: { sha: `${sha.slice(0, 39)}0`, url: "https://api.github.com/" },
        url: "https://api.github.com/",
        comment_count: 0,
        verification: {
          verified: false,
          reason: "unsigned",
          signature: null,
          payload: null,
        },
      },
      url: "https://api.github.com/",
      html_url: "https://github.com/",
      comments_url: "https://api.github.com/",
      author: null,
      committer: null,
      parents: [],
    },
    200,
  );
}

async function treeResponse(
  repository: FakeRepository,
  revision: string,
): Promise<Response> {
  const files = repository.files[revision];
  if (files === undefined) return notFound(revision);
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  const tree = [
    ...[...directories].sort(compareStrings).map((path) => ({
      path,
      mode: "040000",
      type: "tree",
      sha: "1".repeat(40),
      url: "https://api.github.com/",
    })),
    ...(await Promise.all(
      Object.keys(files)
        .sort(compareStrings)
        .map(async (path) => ({
          path,
          mode: repository.modes?.[path] ?? "100644",
          type: repository.modes?.[path] === "160000" ? "commit" : "blob",
          // The id is computed from the bytes this same fake serves. Stated as
          // a constant beside them, the listing and the content could disagree
          // — and a case built on that fake would prove nothing about the check
          // a fetch makes, since every download would fail it.
          sha: await gitObjectIdOf(new TextEncoder().encode(files[path])),
          size: files[path].length,
          url: "https://api.github.com/",
        })),
    )),
  ];
  return jsonResponse(
    {
      sha: revision,
      url: "https://api.github.com/",
      tree,
      truncated: repository.truncated === true,
    },
    200,
  );
}

/**
 * The source repository the remote cases fetch from: one contract at the
 * conventional position, with one conformance case beside it.
 *
 * Stated once because several cases have to agree about what the network
 * answered with — a case that described its own repository could assert
 * against bytes no other case would ever see.
 */
export const REMOTE = {
  repository: "ba0918/agentic-workflow",
  revision: "9f1b7c2d4e5a60718293a4b5c6d7e8f90a1b2c3d",
  id: "tdd-contract",
  contract: "# TDD Contract\n\nWrite the test first, then the code.\n",
  conformanceCase: "A case the contract has to satisfy.\n",
};

/** That repository, in the shape the fake GitHub serves. */
export function remoteSource(): Record<string, FakeRepository> {
  return {
    [REMOTE.repository]: {
      defaultBranch: "main",
      refs: { main: REMOTE.revision },
      files: {
        [REMOTE.revision]: {
          "README.md": "# Workflow\n",
          [`contracts/${REMOTE.id}.md`]: REMOTE.contract,
          [`contracts/${REMOTE.id}/conformance/cases/first.md`]:
            REMOTE.conformanceCase,
        },
      },
    },
  };
}

/**
 * The fixture tree with one skill declaring the remote contract, the source
 * registered, and the cache filled — the state a repository is in right after
 * an `add`.
 */
export async function withFetchedTree(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  await withGoodTree(async (root) => {
    const site = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      site,
      (await fs.readFile(site, "utf8")).replace(
        "    - changelog-entry\n",
        `    - changelog-entry\n    - ${REMOTE.id}\n`,
      ),
    );
    const github = fakeGitHub(remoteSource());
    const added = await runCli(
      ["add", REMOTE.repository, "workflow", "--root", root],
      github.fetch,
    );
    if (added.code !== 0) {
      throw new Error(`add failed: ${added.stderr.join("\n")}`);
    }
    await fn(root);
  });
}
