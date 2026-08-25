import * as fs from "node:fs/promises";
import { gitObjectIdOf } from "../contracts/digest.ts";
import { compareStrings } from "../ordering.ts";
import { runCli } from "./cli.ts";
import { withGoodTree } from "./fixtures.ts";

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
