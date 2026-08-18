import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { CACHE_DIR, cacheIsIgnored, cacheSiteOf, pruneCache } from "./cache.ts";
import { withEmptyDir, writeFile } from "./testing.ts";

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
    expect(await cacheIsIgnored(root)).toStrictEqual(false);

    await writeFile(`${root}/.gitignore`, "/.agentic-skill-vendor/\n");
    expect(await cacheIsIgnored(root)).toStrictEqual(true);
  });
});
