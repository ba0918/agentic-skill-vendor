import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
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
  expect(
    await gitHubOver(github.fetch).pathsAt(REPOSITORY, REVISION),
  ).toStrictEqual([
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
    () => gitHubOver(github.fetch).pathsAt(REPOSITORY, REVISION),
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
