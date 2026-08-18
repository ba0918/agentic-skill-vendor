import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import { cacheSiteOf } from "./cache.ts";
import { gitHubOver } from "./github.ts";
import { commandAdd } from "./addcmd.ts";
import { parseDeclaration } from "./sources.ts";
import {
  fakeGitHub,
  type FakeRepository,
  readLockFile,
  rejectedBy,
  runCli,
  snapshotTree,
  withGoodTree,
  writeFile,
} from "./testing.ts";

const REPOSITORY = "ba0918/agentic-workflow";
const REVISION = "9f1b7c2d4e5a60718293a4b5c6d7e8f90a1b2c3d";
const CONTRACT = "# TDD Contract\n\nWrite the test first.\n";

function workflow(): Record<string, FakeRepository> {
  return {
    [REPOSITORY]: {
      defaultBranch: "release/2.x",
      refs: { "release/2.x": REVISION },
      files: {
        [REVISION]: {
          "README.md": "# Workflow\n",
          "contracts/tdd-contract.md": CONTRACT,
        },
      },
    },
  };
}

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

test("add registers the source at the branch the repository hands out and takes up what it holds", async () => {
  await withGoodTree(async (root) => {
    // The ref is written down as the value the repository answered with, not
    // left implicit. A table saying nothing about the branch would resolve
    // against whatever the default happened to be on the day it ran.
    await declareInSkill(root, "tdd-contract");
    const lines: string[] = [];
    const github = fakeGitHub(workflow());

    const code = await commandAdd(
      root,
      (line) => lines.push(line),
      gitHubOver(github.fetch),
      REPOSITORY,
      undefined,
    );

    expect(code, lines.join("\n")).toStrictEqual(0);
    const declaration = parseDeclaration(
      await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
    );
    expect(declaration.sources["agentic-workflow"]).toStrictEqual({
      repository: REPOSITORY,
      ref: "release/2.x",
    });
    expect(declaration.contracts["tdd-contract"]).toStrictEqual({
      source: "agentic-workflow",
    });
    expect(lines).toContain("mapped: tdd-contract <- agentic-workflow");
    expect(lines).toContain(
      `resolved: agentic-workflow ${REVISION} (initial resolution)`,
    );
    expect(
      (await readLockFile(root)).sources["agentic-workflow"],
    ).toStrictEqual({ repository: REPOSITORY, revision: REVISION });
    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf(
          "agentic-workflow",
          REVISION,
          "contracts/tdd-contract.md",
        )}`,
        "utf8",
      ),
    ).toStrictEqual(CONTRACT);
  });
});

test("a repository already registered is refused rather than written twice", async () => {
  await withGoodTree(async (root) => {
    // Written twice, the table would carry the same key twice and stop being
    // readable at all — every later run refused over a file this command
    // produced.
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      [
        "sources:",
        "  agentic-workflow:",
        `    repository: ${REPOSITORY}`,
        "    ref: main",
        "",
      ].join("\n"),
    );
    const github = fakeGitHub(workflow());

    const before = await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8");
    const error = await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(github.fetch),
          REPOSITORY,
          undefined,
        ),
      ConfigError,
    );
    expect(error.message).toContain("already registers");
    // The refusal comes before anything is written. Written first and refused
    // afterwards, the table would carry the key twice and stop being readable
    // at all — every later run refused over a file this command produced.
    expect(
      await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
    ).toStrictEqual(before);
  });
});

test("a repository whose name could not be a source name asks for one to be given", async () => {
  await withGoodTree(async (root) => {
    // The name becomes a directory under the cache and a key in the lock, so
    // it is held to the same shape a contract id is. Rewriting it quietly
    // would let two repositories land under one name.
    const github = fakeGitHub({
      "ba0918/Agentic.Workflow": workflow()[REPOSITORY],
    });
    const error = await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(github.fetch),
          "ba0918/Agentic.Workflow",
          undefined,
        ),
      ConfigError,
    );
    expect(error.message).toContain("source name");
    // Nothing is written, so the tree is where it was: a table holding a name
    // the schema refuses is one every later run stops on.
    expect(await fs.exists(`${root}/vendor-manifest.yaml`)).toStrictEqual(
      false,
    );
  });
});

test("a source name given by hand is what the source is registered under", async () => {
  await withGoodTree(async (root) => {
    const github = fakeGitHub(workflow());
    await commandAdd(
      root,
      () => {},
      gitHubOver(github.fetch),
      REPOSITORY,
      "workflow",
    );
    expect(
      parseDeclaration(
        await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
      ).sources["workflow"],
    ).toStrictEqual({ repository: REPOSITORY, ref: "release/2.x" });
  });
});

test("the add command names the repository as its one argument", async () => {
  await withGoodTree(async (root) => {
    const github = fakeGitHub(workflow());
    const result = await runCli(
      ["add", REPOSITORY, "--root", root],
      github.fetch,
    );
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(
      parseDeclaration(
        await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
      ).sources["agentic-workflow"].repository,
    ).toStrictEqual(REPOSITORY);
  });
});

test("add with no repository named is a usage error", async () => {
  const result = await runCli(["add"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stderr.join("\n")).toContain("owner/repo");
});

test("the update command moves every registered pin", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      [
        "sources:",
        "  workflow:",
        `    repository: ${REPOSITORY}`,
        "    ref: release/2.x",
        "",
      ].join("\n"),
    );
    const github = fakeGitHub(workflow());
    const result = await runCli(["update", "--root", root], github.fetch);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(
      (await readLockFile(root)).sources["workflow"].revision,
    ).toStrictEqual(REVISION);
  });
});

test("the name reserved for this repository is refused before the table is written", async () => {
  await withGoodTree(async (root) => {
    // `source: local` has to keep one reading, so the name cannot be handed to
    // a repository. Refused only once the schema reads the table back, the
    // refusal would come after the entry had already landed on disk — a file
    // this command wrote and every later run stops on.
    const github = fakeGitHub(workflow());
    const error = await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(github.fetch),
          REPOSITORY,
          "local",
        ),
      ConfigError,
    );
    expect(error.message).toContain("local");
    expect(await fs.exists(`${root}/vendor-manifest.yaml`)).toStrictEqual(
      false,
    );
  });
});

test("add leaves a table it could not revise readably exactly as it was", async () => {
  await withGoodTree(async (root) => {
    // The scribe writes lines rather than rendering the document, so it can
    // only guess at the shape a person wrote: an entry indented four spaces
    // takes a two-space one beside it and the file stops being readable YAML.
    // Written first and read back afterwards, that file is on disk and every
    // command — verify, gen, update, fetch, add — stops on it, with hand
    // editing the only way out.
    const table = [
      "sources:",
      "    meta:",
      "        repository: ba0918/agentic-meta",
      "        ref: main",
      "",
    ].join("\n");
    await writeFile(`${root}/vendor-manifest.yaml`, table);
    const github = fakeGitHub(workflow());

    const error = await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(github.fetch),
          REPOSITORY,
          undefined,
        ),
      ConfigError,
    );

    expect(error.message).toContain("vendor-manifest.yaml");
    expect(
      await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8"),
    ).toStrictEqual(table);
  });
});

test("add refused over a source already registered names the command that finishes taking it up", async () => {
  await withGoodTree(async (root) => {
    // The source is registered first and the fetching half runs afterwards, so
    // a run whose second half could not reach the repository leaves the source
    // registered with no commit pinned for it. Nothing about that tree is
    // broken — gen and verify stay clean and update completes it — but the
    // move a person makes is to run add again, and this refusal is the only
    // place that can say where to go from there.
    const unreachable = fakeGitHub({
      [REPOSITORY]: { ...workflow()[REPOSITORY], refs: {} },
    });
    await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(unreachable.fetch),
          REPOSITORY,
          undefined,
        ),
      ConfigError,
    );
    expect("sources" in (await readLockFile(root))).toStrictEqual(false);

    const github = fakeGitHub(workflow());
    const error = await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(github.fetch),
          REPOSITORY,
          undefined,
        ),
      ConfigError,
    );

    expect(error.message).toContain("run update");
  });
});

test("a default branch that could not be read back as a ref is refused before the table is written", async () => {
  await withGoodTree(async (root) => {
    // The branch comes from the repository being registered, and it is written
    // into the table as an unquoted scalar. A name carrying a line break puts
    // lines of its own into the document — this one adds a top-level key — and
    // the table still reads as YAML afterwards, so nothing downstream notices.
    // A ref read out of that same table is held to a strict shape; the value
    // arriving from the source is now held to it too.
    const github = fakeGitHub({
      [REPOSITORY]: {
        ...workflow()[REPOSITORY],
        defaultBranch: "release/2.x\nrogue: planted by the answer",
      },
    });
    const before = await snapshotTree(root);

    const error = await rejectedBy(
      () =>
        commandAdd(
          root,
          () => {},
          gitHubOver(github.fetch),
          REPOSITORY,
          undefined,
        ),
      ConfigError,
    );

    expect(error.message).toContain("branch");
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});
