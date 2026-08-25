import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { pruneCache } from "./cache.ts";
import {
  CACHE_DIR,
  cacheRevisionDirOf,
  cacheSiteOf,
} from "../contracts/cache.ts";
import { workDirectoryIsIgnored } from "../filesystem/workdir.ts";
import { withEmptyDir } from "../test-support/fixtures.ts";
import { writeFile } from "../test-support/filesystem.ts";
import { TEMPORARY_SUFFIX } from "../filesystem/walk.ts";

test("a fetched file is placed under its source and the revision it came from", () => {
  // The revision is a directory level of its own, which is what makes pruning
  // a superseded version the removal of one directory rather than a diff
  // against the file list of another.
  expect(
    cacheSiteOf("workflow", "a".repeat(40), "contracts/tdd-contract.md"),
  ).toStrictEqual(
    `.agentic-skill-vendor/cache/workflow/${"a".repeat(40)}/contracts/tdd-contract.md`,
  );
});

const REVISION = "b".repeat(40);
const SUPERSEDED = "c".repeat(40);
const SOURCES = {
  workflow: { repository: "ba0918/agentic-workflow", revision: REVISION },
};

test("a revision the lock no longer names is cleared out of the cache", async () => {
  await withEmptyDir(async (root) => {
    // The pin moved and the bytes behind the old one answer no question any
    // more. Left behind, the cache grows by one full copy per update and a
    // reader cannot tell which directory the tree is actually distributing.
    await writeFile(
      `${root}/${cacheSiteOf("workflow", REVISION, "contracts/a.md")}`,
      "current\n",
    );
    await writeFile(
      `${root}/${cacheSiteOf("workflow", SUPERSEDED, "contracts/a.md")}`,
      "superseded\n",
    );

    await pruneCache(root, SOURCES);

    expect(
      await fs.readFile(
        `${root}/${cacheSiteOf("workflow", REVISION, "contracts/a.md")}`,
        "utf8",
      ),
    ).toStrictEqual("current\n");
    expect(
      await fs.exists(`${root}/${CACHE_DIR}/workflow/${SUPERSEDED}`),
    ).toStrictEqual(false);
  });
});

test("a source the lock no longer records is cleared out of the cache whole", async () => {
  await withEmptyDir(async (root) => {
    await writeFile(
      `${root}/${cacheSiteOf("withdrawn", REVISION, "contracts/a.md")}`,
      "withdrawn\n",
    );
    await pruneCache(root, SOURCES);
    expect(await fs.exists(`${root}/${CACHE_DIR}/withdrawn`)).toStrictEqual(
      false,
    );
  });
});

test("the cache counts as ignored only where the tree's own rules exclude it", async () => {
  // Committed, the cache would put a second copy of every fetched contract
  // into the repository — the mirror the whole design exists to avoid. The
  // rules are read the way git reads them, so an unanchored pattern is judged
  // the same way git would judge it.
  await withEmptyDir(async (root) => {
    await writeFile(`${root}/${CACHE_DIR}/workflow/keep.md`, "cached\n");
    expect(await workDirectoryIsIgnored(root, CACHE_DIR)).toStrictEqual(false);

    await writeFile(`${root}/.gitignore`, "/.agentic-skill-vendor/\n");
    expect(await workDirectoryIsIgnored(root, CACHE_DIR)).toStrictEqual(true);
  });
});

test("a revision's directory is the level a whole fetch is placed at", () => {
  expect(cacheRevisionDirOf("workflow", REVISION)).toStrictEqual(
    `.agentic-skill-vendor/cache/workflow/${REVISION}`,
  );
});

test("a temporary a stopped fetch left behind is cleared out of the cache", async () => {
  await withEmptyDir(async (root) => {
    // A half-built directory is not a revision and must never be read as one.
    // Its name carries the temporary suffix, so it can be no revision the lock
    // pins and falls to the same rule a superseded one does.
    await writeFile(
      `${root}/${cacheRevisionDirOf("workflow", REVISION)}${TEMPORARY_SUFFIX}/contracts/a.md`,
      "half of a fetch\n",
    );
    await writeFile(
      `${root}/${cacheSiteOf("workflow", REVISION, "contracts/a.md")}`,
      "current\n",
    );

    await pruneCache(root, SOURCES);

    expect(await fs.readdir(`${root}/${CACHE_DIR}/workflow`)).toStrictEqual([
      REVISION,
    ]);
  });
});

test("pruning refuses a tool directory that is a symlink and leaves what it points at untouched", async () => {
  await withEmptyDir(async (outside) => {
    await withEmptyDir(async (root) => {
      // The prune removes whole directories by name under the cache. With the
      // tool directory itself a link, those names resolve outside the tree,
      // and a recursive removal there would take someone else's files.
      await writeFile(
        `${outside}/cache/withdrawn/${REVISION}/contracts/a.md`,
        "not ours\n",
      );
      await fs.symlink(outside, `${root}/.agentic-skill-vendor`);

      await expect(pruneCache(root, SOURCES)).rejects.toThrow(
        "symlink is not allowed inside the tree: .agentic-skill-vendor",
      );
      expect(
        await fs.readFile(
          `${outside}/cache/withdrawn/${REVISION}/contracts/a.md`,
          "utf8",
        ),
      ).toStrictEqual("not ours\n");
    });
  });
});
