import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import { contractDigest } from "./digest.ts";
import { CACHE_DIR, cacheRevisionDirOf, cacheSiteOf } from "./cache.ts";
import { gitHubOver } from "./github.ts";
import { parseDeclaration } from "./sources.ts";
import { commandFetch, commandUpdate } from "./resolvecmd.ts";
import {
  escapeThrough,
  fakeGitHub,
  type FakeRepository,
  readLockFile,
  rejectedBy,
  runCli,
  snapshotTree,
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

test("fetch rebuilds the cache the commit describes even where the lock records another digest", async () => {
  await withRemoteTree(async (root, lines) => {
    // A lock recording one digest while the pinned commit holds another text
    // used to be a state nothing could leave: fetch refused over the
    // disagreement, gen asked for a cache fetch would not write, and verify
    // called the tree clean. The cache is rebuilt from the commit instead, and
    // the disagreement is what the next gen reports as an adoption.
    const lock = await readLockFile(root);
    lock.resolutions["tdd-contract"] = {
      digest: await contractDigest("# TDD Contract\n\nThe text before.\n"),
    };
    await writeLockFile(root, lock);
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
    // Through the command line, bytes that are not the ones the commit lists
    // are a refusal — not a violation of the tree, which is what exit 1 means
    // and what continuous integration acts on.
    const github = fakeGitHub(workflow());
    const tampered = (async (input: string | URL | Request) =>
      String(input).startsWith("https://raw.githubusercontent.com/")
        ? new Response("# TDD Contract\n\nElse.\n")
        : await github.fetch(input)) as typeof fetch;

    const result = await runCli(["fetch", "--root", root], tampered);
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain("object id");
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

test("update resolves the ref to the commit it names and records it in the lock", async () => {
  await withRemoteTree(async (root, lines) => {
    // The declaration names a branch, which moves. The lock names a commit,
    // which does not. This is the moment one becomes the other, and the line
    // it reports is what a reviewer reads in the pull request.
    const lock = await readLockFile(root);
    delete lock.sources;
    await writeLockFile(root, lock);
    const github = fakeGitHub(workflow());

    const code = await commandUpdate(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    expect((await readLockFile(root)).sources).toStrictEqual({
      workflow: { repository: REPOSITORY, revision: REVISION },
    });
    expect(lines).toContain(
      `resolved: workflow ${REVISION} (initial resolution)`,
    );
  });
});

test("update reports a pin that moved from one commit to another", async () => {
  await withRemoteTree(async (root, lines) => {
    const before = "0".repeat(40);
    const lock = await readLockFile(root);
    lock.sources = { workflow: { repository: REPOSITORY, revision: before } };
    await writeLockFile(root, lock);
    const github = fakeGitHub(workflow());

    await commandUpdate(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(lines).toContain(`resolved: workflow ${before} -> ${REVISION}`);
  });
});

test("update takes up text that has moved on since the lock was written", async () => {
  await withRemoteTree(async (root, lines) => {
    // Adopting a new version is what update is for, so text differing from
    // what the lock records is the ordinary case rather than a refusal. What
    // the difference is gets recorded by the gen that follows, as an adoption
    // a reviewer reads in the lock's diff.
    const moved = "# TDD Contract\n\nWrite the test first, then the code.\n";
    const lock = await readLockFile(root);
    lock.resolutions["tdd-contract"] = {
      digest: await contractDigest(CONTRACT),
    };
    await writeLockFile(root, lock);
    const github = fakeGitHub(workflow({ "contracts/tdd-contract.md": moved }));

    const code = await commandUpdate(
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
    ).toStrictEqual(moved);
  });
});

test("update warns about an unignored cache and clears a superseded revision", async () => {
  await withRemoteTree(async (root, lines) => {
    // Every command that fills the cache leaves the tree in the same state, so
    // every one of them has to say the same thing about a cache the repository
    // would commit, and clear what the new pin left behind.
    const superseded = "0".repeat(40);
    await writeFile(
      `${root}/${cacheSiteOf("workflow", superseded, "contracts/tdd-contract.md")}`,
      "the version before this one\n",
    );
    const github = fakeGitHub(workflow());

    await commandUpdate(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(lines.join("\n")).toContain("warning:");
    expect(
      await fs.exists(
        `${root}/.agentic-skill-vendor/cache/workflow/${superseded}`,
      ),
    ).toStrictEqual(false);
  });
});

/** Declares `id` in a skill of the fixture tree, the way a person would. */
async function declareInSkill(root: string, id: string): Promise<void> {
  const site = `${root}/skills/release-notes/SKILL.md`;
  const text = await fs.readFile(site, "utf8");
  await fs.writeFile(
    site,
    text.replace(
      "    - changelog-entry\n",
      `    - changelog-entry\n    - ${id}\n`,
    ),
  );
}

test("a declared contract found at one source's conventional position is mapped and reported", async () => {
  await withGoodTree(async (root) => {
    // The one thing a person writes is the id in the skill. Which source holds
    // it is a question the tool can answer by looking, and the answer is
    // written down as a line a reviewer sees in the diff.
    await declareInSkill(root, "tdd-contract");
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      [
        "sources:",
        "  workflow:",
        `    repository: ${REPOSITORY}`,
        "    ref: main",
        "",
      ].join("\n"),
    );
    const lines: string[] = [];
    const github = fakeGitHub(workflow());

    const code = await commandUpdate(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    expect(lines).toContain("mapped: tdd-contract <- workflow");
    expect(
      parseDeclaration(
        await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
      ).contracts["tdd-contract"],
    ).toStrictEqual({ source: "workflow" });
    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf("workflow", REVISION, "contracts/tdd-contract.md")}`,
        "utf8",
      ),
    ).toStrictEqual(CONTRACT);
  });
});

const OTHER = "ba0918/agentic-meta";

/** Two sources holding the same contract at the conventional position. */
function twoHolders() {
  return {
    ...workflow(),
    [OTHER]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: {
        [REVISION]: {
          "contracts/tdd-contract.md": "# TDD Contract\n\nAnother copy.\n",
        },
      },
    },
  };
}

async function writeTwoSourceTable(root: string, contracts: string[] = []) {
  await writeFile(
    `${root}/vendor-manifest.yaml`,
    [
      "sources:",
      "  meta:",
      `    repository: ${OTHER}`,
      "    ref: main",
      "  workflow:",
      `    repository: ${REPOSITORY}`,
      "    ref: main",
      "",
      ...contracts,
    ].join("\n"),
  );
}

test("a declared contract two sources hold stops the run and asks for the line to be written", async () => {
  await withGoodTree(async (root) => {
    // Letting one of them win quietly is how a document ends up maintained in
    // two places with nothing saying which copy the tree distributes. The
    // refusal is the moment that duplication becomes visible.
    await declareInSkill(root, "tdd-contract");
    await writeTwoSourceTable(root);
    const lines: string[] = [];
    const github = fakeGitHub(twoHolders());

    const error = await rejectedBy(
      () =>
        commandUpdate(
          root,
          (line) => lines.push(line),
          gitHubOver(github.fetch),
        ),
      ConfigError,
    );

    expect(error.message).toContain("tdd-contract");
    expect(error.message).toContain("meta");
    expect(error.message).toContain("workflow");
  });
});

test("a mapping already written wins over the search, whatever else holds the contract", async () => {
  await withGoodTree(async (root) => {
    // The line is itself the adjudication the search would otherwise have to
    // make, so a second holder is no longer a question worth stopping over.
    await declareInSkill(root, "tdd-contract");
    await writeTwoSourceTable(root, [
      "contracts:",
      "  tdd-contract:",
      "    source: meta",
      "",
    ]);
    const lines: string[] = [];
    const github = fakeGitHub(twoHolders());

    const code = await commandUpdate(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf("meta", REVISION, "contracts/tdd-contract.md")}`,
        "utf8",
      ),
    ).toStrictEqual("# TDD Contract\n\nAnother copy.\n");
  });
});

test("fetch refuses to write through a link planted above a revision", async () => {
  await withRemoteTree(async (root, lines) => {
    // A link above the revision directory would have the whole placement land
    // outside the tree the run was pointed at. Every write goes through the
    // guarded primitive, so the refusal is a property of the write rather than
    // of this command.
    await writeFile(
      `${root}/${cacheSiteOf("workflow", REVISION, "contracts/placeholder.md")}`,
      "placeholder\n",
    );
    const outside = await escapeThrough(root, `${CACHE_DIR}/workflow`);
    const before = await snapshotTree(outside);
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

    expect(error.message).toContain("symlink");
    expect(await snapshotTree(outside)).toStrictEqual(before);
  });
});

test("a link planted inside a revision is replaced with the fetch rather than written through", async () => {
  await withRemoteTree(async (root, lines) => {
    // The revision directory is placed whole, so whatever a previous state left
    // inside it goes with it. The link is unlinked rather than followed: what
    // it pointed at outside the tree is left exactly as it was, and the cache
    // ends up holding the file the commit holds.
    await writeFile(
      `${root}/${cacheSiteOf("workflow", REVISION, "contracts/placeholder.md")}`,
      "placeholder\n",
    );
    const outside = await escapeThrough(
      root,
      `${cacheRevisionDirOf("workflow", REVISION)}/contracts`,
    );
    const before = await snapshotTree(outside);
    const github = fakeGitHub(workflow());

    const code = await commandFetch(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    expect(await snapshotTree(outside)).toStrictEqual(before);
    const site = cacheSiteOf("workflow", REVISION, "contracts/tdd-contract.md");
    expect((await fs.lstat(`${root}/${site}`)).isFile()).toStrictEqual(true);
    expect(await fs.readFile(`${root}/${site}`, "utf8")).toStrictEqual(
      CONTRACT,
    );
  });
});

test("a contract this repository holds itself is never captured by a source that also holds it", async () => {
  await withGoodTree(async (root) => {
    // The derivation is ordered: a canonical text in this repository settles
    // the question before any source is looked at. Searched first, registering
    // a source that happens to carry the same id would quietly move the
    // authority over an existing contract to another repository — a capture
    // with no line anywhere saying it happened.
    // Two sources carry it as well, so this also states the order: the local
    // text settles the question before the refusal over several holders is
    // even reached.
    await writeTwoSourceTable(root);
    const lines: string[] = [];
    const elsewhere = {
      "contracts/changelog-entry.md": "# Changelog Entry\n\nAnother copy.\n",
    };
    const github = fakeGitHub({
      ...workflow(elsewhere),
      [OTHER]: {
        defaultBranch: "main",
        refs: { main: REVISION },
        files: { [REVISION]: elsewhere },
      },
    });

    const code = await commandUpdate(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    expect(lines.join("\n")).not.toContain("mapped: changelog-entry");
    expect(
      "changelog-entry" in
        parseDeclaration(
          await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
        ).contracts,
    ).toStrictEqual(false);
    // gen writes the line it belongs to, and the copies keep coming from the
    // text this repository is authority over.
    expect((await runCli(["gen", "--root", root])).stdout).toContain(
      "mapped: changelog-entry <- local",
    );
    expect(
      await fs.readFile(
        `${root}/skills/release-notes/references/vendor/changelog-entry.md`,
        "utf8",
      ),
    ).toContain("An entry names the change first");
  });
});

test("update leaves no table behind in a tree that keeps none", async () => {
  await withGoodTree(async (root) => {
    // Every contract this tree declares is one it holds itself, so the search
    // for a source that holds them has nothing to write down. Written anyway,
    // the empty result lands as a file holding no document at all — and this
    // tool's own reader refuses that, so the run that produced the file is the
    // last one the tree gets through.
    const result = await runCli(["update", "--root", root]);

    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(await fs.exists(`${root}/vendor-manifest.yaml`)).toStrictEqual(
      false,
    );
    const after = await runCli(["verify", "--root", root]);
    expect(after.code, after.stderr.join("\n")).toStrictEqual(0);
  });
});

test("update that cannot fetch what it resolved leaves the tree exactly as it was", async () => {
  await withGoodTree(async (root) => {
    // The lock and the table have to move together: a table naming a source
    // for a contract whose text never arrived describes a tree that does not
    // exist. The run is recoverable by running update again, but only because
    // the next run happens to redo the same work — the tree in between is one
    // no reviewer could read as a state the tool meant to produce.
    await declareInSkill(root, "tdd-contract");
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      [
        "sources:",
        "  workflow:",
        `    repository: ${REPOSITORY}`,
        "    ref: main",
        "",
      ].join("\n"),
    );
    const github = fakeGitHub(workflow());
    const unreachable = (async (input: string | URL | Request) =>
      String(input).startsWith("https://raw.githubusercontent.com/")
        ? new Response("the host is down", { status: 503 })
        : await github.fetch(input)) as typeof fetch;
    const before = await snapshotTree(root);

    await rejectedBy(
      () => commandUpdate(root, () => {}, gitHubOver(unreachable)),
      ConfigError,
    );

    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});

test("a listing that walks out of the repository writes nothing outside the tree", async () => {
  await withRemoteTree(async (root, lines) => {
    // Every conformance file the listing names becomes a cache site under the
    // tree root. A path carrying enough upward steps lands past the root, so a
    // host answering with one would have the run write wherever it said —
    // silently, on the exit code of a clean fetch.
    const outside = root.slice(0, root.lastIndexOf("/"));
    const before = await snapshotTree(outside);
    const github = fakeGitHub(
      workflow({
        "contracts/tdd-contract.md": CONTRACT,
        "contracts/tdd-contract/conformance/cases/first.md": CASE,
        [`contracts/tdd-contract/conformance/${"../".repeat(8)}escape.md`]:
          "planted by the answer\n",
      }),
    );

    await rejectedBy(
      () =>
        commandFetch(
          root,
          (line) => lines.push(line),
          gitHubOver(github.fetch),
        ),
      ConfigError,
    );

    expect(await snapshotTree(outside)).toStrictEqual(before);
  });
});

test("bytes that are not what the commit's own listing names are refused and nothing is cached", async () => {
  await withRemoteTree(async (root, lines) => {
    // The listing gives an object id for every file it names, so the bytes can
    // be judged against the commit they came from without any comparison
    // against the lock. Bytes that fail it are a transfer that went wrong or a
    // source answering with something the commit does not hold — either way,
    // not a version to take up.
    const github = fakeGitHub(workflow());
    const tampered = (async (input: string | URL | Request) =>
      String(input).startsWith("https://raw.githubusercontent.com/")
        ? new Response("# TDD Contract\n\nBytes nobody committed.\n")
        : await github.fetch(input)) as typeof fetch;

    const error = await rejectedBy(
      () =>
        commandFetch(root, (line) => lines.push(line), gitHubOver(tampered)),
      ConfigError,
    );

    expect(error.message).toContain("object id");
    expect(await fs.exists(`${root}/.agentic-skill-vendor`)).toStrictEqual(
      false,
    );
  });
});

test("a fetch that cannot place a revision whole leaves no revision directory behind", async () => {
  await withRemoteTree(async (root, lines) => {
    // A revision directory standing at its place is what every later command
    // reads as "this revision was taken up". A run that stopped part way must
    // therefore leave nothing there at all, rather than a directory holding
    // whichever files happened to arrive first.
    const github = fakeGitHub(
      workflow({
        "contracts/tdd-contract.md": CONTRACT,
        "contracts/tdd-contract/conformance/cases/first.md": CASE,
        "contracts/tdd-contract/conformance/cases/first.md/second.md": CASE,
      }),
    );

    await rejectedBy(
      () =>
        commandFetch(
          root,
          (line) => lines.push(line),
          gitHubOver(github.fetch),
        ),
      ConfigError,
    );

    expect(
      await fs.exists(`${root}/${cacheRevisionDirOf("workflow", REVISION)}`),
    ).toStrictEqual(false);
  });
});
