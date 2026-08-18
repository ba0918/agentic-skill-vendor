import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { gitObjectIdOf } from "./digest.ts";
import {
  commitUrl,
  gitHubOver,
  rawUrl,
  repositoryUrl,
  treeUrl,
} from "./github.ts";
import { fakeGitHub, rejectedBy } from "./testing.ts";

test("every request is built against the two hosts the tool talks to", () => {
  // The host is never taken from anything the tree says. A declaration that
  // could name it would turn a contract mapping into a way of pointing this
  // tool at any server at all.
  expect(repositoryUrl("ba0918/agentic-workflow")).toStrictEqual(
    "https://api.github.com/repos/ba0918/agentic-workflow",
  );
  expect(commitUrl("ba0918/agentic-workflow", "main")).toStrictEqual(
    "https://api.github.com/repos/ba0918/agentic-workflow/commits/main",
  );
  expect(treeUrl("ba0918/agentic-workflow", "a".repeat(40))).toStrictEqual(
    `https://api.github.com/repos/ba0918/agentic-workflow/git/trees/${"a".repeat(
      40,
    )}?recursive=1`,
  );
  expect(
    rawUrl("ba0918/agentic-workflow", "a".repeat(40), "contracts/tdd.md"),
  ).toStrictEqual(
    `https://raw.githubusercontent.com/ba0918/agentic-workflow/${"a".repeat(
      40,
    )}/contracts/tdd.md`,
  );
});

test("a branch name spelled with a separator keeps its separator in the request", () => {
  // `release/2.x` is a legal branch and may be a repository's default one.
  // Percent-encoded whole, it would name a branch nobody has.
  expect(commitUrl("ba0918/agentic-workflow", "release/2.x")).toStrictEqual(
    "https://api.github.com/repos/ba0918/agentic-workflow/commits/release/2.x",
  );
});

const REVISION = "9f1b7c2d4e5a60718293a4b5c6d7e8f90a1b2c3d";
const REPOSITORY = "ba0918/agentic-workflow";

function workflowRepository() {
  return {
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: {
        [REVISION]: {
          "README.md": "# Workflow\n",
          "contracts/tdd-contract.md":
            "# TDD Contract\n\nWrite the test first.\n",
          "contracts/tdd-contract/conformance/cases/first.md": "A case.\n",
        },
      },
    },
  };
}

test("a ref is resolved to the commit it names right now", async () => {
  // The lock records a commit and never a branch, so this is where a moving
  // name is turned into a fixed one — the moment a version is adopted.
  const github = fakeGitHub(workflowRepository());
  expect(
    await gitHubOver(github.fetch).commitOf(REPOSITORY, "main"),
  ).toStrictEqual(REVISION);
  expect(github.requested).toStrictEqual([
    `https://api.github.com/repos/${REPOSITORY}/commits/main`,
  ]);
});

test("the branch a repository hands out by default is read from the repository", async () => {
  // `add` records an explicit ref, so the default branch has to be asked for
  // once rather than assumed to be one of the two names that are common.
  const github = fakeGitHub(workflowRepository());
  expect(
    await gitHubOver(github.fetch).defaultBranchOf(REPOSITORY),
  ).toStrictEqual("main");
});

test("the files one commit holds are listed and the directories are left out", async () => {
  // The listing answers two questions offline afterwards: whether a source
  // holds a contract at the conventional position, and which conformance files
  // sit beside it. A directory entry answers neither.
  const github = fakeGitHub(workflowRepository());
  const listed = await gitHubOver(github.fetch).blobsAt(REPOSITORY, REVISION);
  expect(listed.map((entry) => entry.path)).toStrictEqual([
    "README.md",
    "contracts/tdd-contract.md",
    "contracts/tdd-contract/conformance/cases/first.md",
  ]);
});

test("a file is fetched as the bytes the commit holds", async () => {
  const github = fakeGitHub(workflowRepository());
  const bytes = await gitHubOver(github.fetch).fileAt(
    REPOSITORY,
    REVISION,
    "contracts/tdd-contract.md",
  );
  expect(new TextDecoder().decode(bytes)).toStrictEqual(
    "# TDD Contract\n\nWrite the test first.\n",
  );
});

test("a listing the service had to cut short is refused rather than read as complete", async () => {
  // A cut-short listing looks exactly like a repository that holds fewer
  // files. Read as complete, a contract's conformance tests would be pinned as
  // absent and the tree would verify clean against a pin that lost them.
  const github = fakeGitHub({
    [REPOSITORY]: { ...workflowRepository()[REPOSITORY], truncated: true },
  });
  const error = await rejectedBy(
    () => gitHubOver(github.fetch).blobsAt(REPOSITORY, REVISION),
    ConfigError,
  );
  expect(error.message).toContain("truncated");
});

test("a request the service did not answer is refused, naming the status", async () => {
  // Read as "the repository holds nothing", a 404 would be reported as a
  // closure gap about a repository the run never reached.
  const github = fakeGitHub(workflowRepository());
  const error = await rejectedBy(
    () => gitHubOver(github.fetch).commitOf("ba0918/absent", "main"),
    ConfigError,
  );
  expect(error.message).toContain("404");
});

test("an answer far larger than a shared document is refused", async () => {
  // The contracts this tool distributes are documents. Whatever a host is
  // willing to stream, the run stops reading once the answer has stopped
  // looking like one.
  const oversized = "x".repeat(2 * 1024 * 1024);
  const github = fakeGitHub({
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: { [REVISION]: { "contracts/huge.md": oversized } },
    },
  });
  const error = await rejectedBy(
    () =>
      gitHubOver(github.fetch).fileAt(
        REPOSITORY,
        REVISION,
        "contracts/huge.md",
      ),
    ConfigError,
  );
  expect(error.message).toContain("too large");
});

test("an answer that is not shaped like the API's own is refused, never guessed at", async () => {
  // A body that parses but says nothing the caller asked for is not an
  // absence: read as one, the run would record an empty revision or a
  // repository with no branches as though the service had said so.
  const shapes = [
    `{"message":"Moved Permanently"}`,
    `{"sha":"not-a-commit-sha"}`,
    `[]`,
  ];
  for (const body of shapes) {
    const transport = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await rejectedBy(
      () => gitHubOver(transport).commitOf(REPOSITORY, "main"),
      ConfigError,
    );
  }
});

test("a body that is not JSON at all is refused as an unreadable answer", async () => {
  const transport = (async () =>
    new Response("<html>rate limited</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  const error = await rejectedBy(
    () => gitHubOver(transport).blobsAt(REPOSITORY, REVISION),
    ConfigError,
  );
  expect(error.message).toContain("unreadable JSON");
});

test("a listing naming a file outside the repository it lists is refused", async () => {
  // The paths in this answer are joined onto cache directories and onto request
  // URLs, so a segment that walks upward has a fetch write wherever it points.
  // The shape is judged here, where the answer arrives, rather than left to
  // each caller: the declaration side already holds paths to this rule, and an
  // answer from a host is trusted less than a line in this tree, not more.
  // Dropping the entry silently was the other way out, and it hides a host
  // answering with something a repository cannot hold.
  const github = fakeGitHub({
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: {
        [REVISION]: {
          "contracts/tdd-contract.md": "# TDD Contract\n",
          "contracts/tdd-contract/conformance/../../../escape.md": "planted\n",
        },
      },
    },
  });

  const error = await rejectedBy(
    () => gitHubOver(github.fetch).blobsAt(REPOSITORY, REVISION),
    ConfigError,
  );
  expect(error.message).toContain("escape.md");
});

test("the listing carries the object id the commit gives each file", async () => {
  // The id is what a download is judged against, so it has to come from the
  // same answer that says the file exists. Asked for separately, the two could
  // describe different commits.
  const github = fakeGitHub(workflowRepository());
  const listed = await gitHubOver(github.fetch).blobsAt(REPOSITORY, REVISION);
  const readme = listed.find((entry) => entry.path === "README.md");
  expect(readme?.objectId).toStrictEqual(
    await gitObjectIdOf(new TextEncoder().encode("# Workflow\n")),
  );
});

test("the listing carries the mode a commit gives each entry rather than judging it", async () => {
  // A listing covers a whole repository, so a mode judged here decides for
  // files the run will never open: one link or one vendored subproject
  // standing anywhere in a source put every contract that source holds out of
  // reach. The mode travels to whoever is about to take the file, and the
  // directories a repository is shaped by are dropped — a directory is not a
  // file this tool takes.
  const github = fakeGitHub({
    [REPOSITORY]: {
      ...workflowRepository()[REPOSITORY],
      modes: {
        "README.md": "160000",
        "contracts/tdd-contract/conformance/cases/first.md": "120000",
      },
    },
  });

  const listed = await gitHubOver(github.fetch).blobsAt(REPOSITORY, REVISION);

  expect(
    new Map(listed.map((entry) => [entry.path, entry.mode])),
  ).toStrictEqual(
    new Map([
      ["README.md", "160000"],
      ["contracts/tdd-contract.md", "100644"],
      ["contracts/tdd-contract/conformance/cases/first.md", "120000"],
    ]),
  );
});

test("a listing giving an entry no mode at all is refused", async () => {
  // The answer failing to be a tree listing, the way a missing path is. Read
  // as some mode this tool declines to take, the entry would describe itself
  // as something no caller can judge.
  const transport = (async () =>
    new Response(
      JSON.stringify({
        sha: REVISION,
        tree: [{ path: "contracts/tdd-contract.md", sha: "a".repeat(40) }],
        truncated: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const error = await rejectedBy(
    () => gitHubOver(transport).blobsAt(REPOSITORY, REVISION),
    ConfigError,
  );

  expect(error.message).toContain("contracts/tdd-contract.md");
  expect(error.message).toContain("no mode");
});

test("an answer that redirects is refused rather than followed", async () => {
  // The hosts this tool talks to are fixed, and following a redirect would
  // make that true of the first request of a chain only: a Location naming any
  // third-party host would be asked next and its answer taken. These endpoints
  // do not normally redirect, so one that does is an anomaly.
  const transport = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.invalid/repos" },
    })) as unknown as typeof fetch;
  const error = await rejectedBy(
    () => gitHubOver(transport).commitOf(REPOSITORY, "main"),
    ConfigError,
  );
  expect(error.message).toContain("redirect");
});

test("every request tells the transport not to follow a redirect itself", async () => {
  // Refusing a 3xx answer only closes the hole if a 3xx answer is what arrives.
  // Left to its default, fetch follows the chain and hands back the last
  // answer, so the refusal above would never see the redirect at all.
  const asked: (RequestInit | undefined)[] = [];
  const transport = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    asked.push(init);
    return new Response(JSON.stringify({ sha: REVISION }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await gitHubOver(transport).commitOf(REPOSITORY, "main");

  expect(asked.map((init) => init?.redirect)).toStrictEqual(["manual"]);
});
