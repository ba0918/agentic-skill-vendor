import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import { contractDigest } from "./digest.ts";
import { cacheSiteOf } from "./cache.ts";
import { gitHubOver } from "./github.ts";
import { commandFetch } from "./resolvecmd.ts";
import {
  fakeGitHub,
  type FakeRepository,
  readLockFile,
  rejectedBy,
  runCli,
  withGoodTree,
  writeFile,
  writeLockFile,
} from "./testing.ts";

const REPOSITORY = "ba0918/agentic-workflow";
const REVISION = "9f1b7c2d4e5a60718293a4b5c6d7e8f90a1b2c3d";
const CONTRACT = "# TDD Contract\n\nWrite the test first.\n";
const CASE = "A case the contract has to satisfy.\n";

function workflow(
  files?: Record<string, string>,
): Record<string, FakeRepository> {
  return {
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: {
        [REVISION]: files ?? {
          "README.md": "# Workflow\n",
          "contracts/tdd-contract.md": CONTRACT,
          "contracts/tdd-contract/conformance/cases/first.md": CASE,
        },
      },
    },
  };
}

/**
 * A tree that maps one contract to a remote source and records the commit it
 * is pinned at, which is the state a clean checkout is in before any fetch.
 */
async function withRemoteTree(
  fn: (root: string, lines: string[]) => Promise<void>,
): Promise<void> {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      [
        "sources:",
        "  workflow:",
        `    repository: ${REPOSITORY}`,
        "    ref: main",
        "",
        "contracts:",
        "  tdd-contract:",
        "    source: workflow",
        "",
      ].join("\n"),
    );
    const lock = await readLockFile(root);
    lock.sources = { workflow: { repository: REPOSITORY, revision: REVISION } };
    await writeLockFile(root, lock);
    const lines: string[] = [];
    await fn(root, lines);
  });
}

test("fetch puts the pinned text and the tests beside it into the cache", async () => {
  await withRemoteTree(async (root, lines) => {
    // A clean checkout holds no cache at all. One fetch is what puts it back,
    // and it reads the lock rather than resolving anything of its own.
    const github = fakeGitHub(workflow());
    const code = await commandFetch(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf("workflow", REVISION, "contracts/tdd-contract.md")}`,
        "utf8",
      ),
    ).toStrictEqual(CONTRACT);
    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf(
          "workflow",
          REVISION,
          "contracts/tdd-contract/conformance/cases/first.md",
        )}`,
        "utf8",
      ),
    ).toStrictEqual(CASE);
    // Nothing else the repository holds is kept: the cache mirrors the
    // contracts the tree uses, never the repository they came from.
    expect(
      await fs.exists(
        `${root}/${cacheSiteOf("workflow", REVISION, "README.md")}`,
      ),
    ).toStrictEqual(false);
  });
});

test("fetch stops and leaves the cache empty when the pinned text is not what the lock adopted", async () => {
  await withRemoteTree(async (root, lines) => {
    // The lock names one immutable commit, so bytes disagreeing with it are
    // not a version that moved — they are an answer that should not have been
    // given. Adopting them would put text nobody reviewed into every skill.
    const lock = await readLockFile(root);
    lock.resolutions["tdd-contract"] = {
      digest: await contractDigest(CONTRACT),
    };
    await writeLockFile(root, lock);
    const github = fakeGitHub(
      workflow({
        "contracts/tdd-contract.md": "# TDD Contract\n\nSomething else.\n",
      }),
    );

    const error = await rejectedBy(
      () =>
        commandFetch(
          root,
          (line) => lines.push(line),
          gitHubOver(github.fetch),
        ),
      ConfigError,
    );
    expect(error.message).toContain("the lock pins");
    expect(await fs.exists(`${root}/.agentic-skill-vendor`)).toStrictEqual(
      false,
    );
  });
});

test("fetch clears a revision the lock has moved off", async () => {
  await withRemoteTree(async (root, lines) => {
    const superseded = "0".repeat(40);
    await writeFile(
      `${root}/${cacheSiteOf("workflow", superseded, "contracts/tdd-contract.md")}`,
      "the version before this one\n",
    );
    const github = fakeGitHub(workflow());

    expect(
      await commandFetch(
        root,
        (line) => lines.push(line),
        gitHubOver(github.fetch),
      ),
    ).toStrictEqual(0);
    expect(
      await fs.exists(
        `${root}/.agentic-skill-vendor/cache/workflow/${superseded}`,
      ),
    ).toStrictEqual(false);
  });
});

test("fetch warns when the tree does not keep the cache out of the repository", async () => {
  await withRemoteTree(async (root, lines) => {
    const github = fakeGitHub(workflow());
    expect(
      await commandFetch(
        root,
        (line) => lines.push(line),
        gitHubOver(github.fetch),
      ),
    ).toStrictEqual(0);
    expect(lines.join("\n")).toContain("warning:");

    await writeFile(`${root}/.gitignore`, "/.agentic-skill-vendor/\n");
    const quiet: string[] = [];
    expect(
      await commandFetch(
        root,
        (line) => quiet.push(line),
        gitHubOver(github.fetch),
      ),
    ).toStrictEqual(0);
    expect(quiet).toStrictEqual([]);
  });
});

test("fetch stops when a registered source has no commit in the lock to fetch", async () => {
  await withRemoteTree(async (root, lines) => {
    // Nothing here can decide which commit that would be: resolving a ref is
    // what update does, and doing it silently would adopt a version nobody
    // reviewed.
    const lock = await readLockFile(root);
    delete lock.sources;
    await writeLockFile(root, lock);
    const github = fakeGitHub(workflow());

    const error = await rejectedBy(
      () =>
        commandFetch(
          root,
          (line) => lines.push(line),
          gitHubOver(github.fetch),
        ),
      ConfigError,
    );
    expect(error.message).toContain("run update");
  });
});

test("the fetch command reports a poisoned answer on the refusal exit code", async () => {
  await withRemoteTree(async (root) => {
    // Through the command line, a mismatch between the pinned digest and the
    // bytes a host answered with is a refusal — not a violation of the tree,
    // which is what exit 1 means and what continuous integration acts on.
    const lock = await readLockFile(root);
    lock.resolutions["tdd-contract"] = {
      digest: await contractDigest(CONTRACT),
    };
    await writeLockFile(root, lock);
    const github = fakeGitHub(
      workflow({ "contracts/tdd-contract.md": "# TDD Contract\n\nElse.\n" }),
    );

    const result = await runCli(["fetch", "--root", root], github.fetch);
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain("the lock pins");
  });
});

test("the fetch command fills the cache the lock describes", async () => {
  await withRemoteTree(async (root) => {
    const github = fakeGitHub(workflow());
    const result = await runCli(["fetch", "--root", root], github.fetch);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf("workflow", REVISION, "contracts/tdd-contract.md")}`,
        "utf8",
      ),
    ).toStrictEqual(CONTRACT);
  });
});
