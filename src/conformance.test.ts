import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import {
  collectConformanceEntries,
  conformanceDigest,
  conformanceDigestOfEntries,
  conformanceDirectory,
} from "./conformance.ts";
import { contractPath } from "./digest.ts";
import {
  escapeThrough,
  rejectedBy,
  replaceWithSymlink,
  snapshotTree,
  withGoodTree,
  writeFile,
} from "./testing.ts";

const encoder = new TextEncoder();

/** The conformance tree of the one fixture contract that ships tests. */
const CONFORMANCE = "contracts/changelog-entry/conformance";

/** A directory beside the tree, standing in for anything outside its boundary. */
function outsideOf(root: string): string {
  return `${root.slice(0, root.lastIndexOf("/"))}/outside`;
}

async function plantOutsideFile(root: string, name: string): Promise<string> {
  const path = `${outsideOf(root)}/${name}`;
  await writeFile(path, "content that must never be touched\n");
  return path;
}

/** The relative paths a conformance collection found, in the order it read them. */
async function collectedPaths(root: string): Promise<string[]> {
  return (await collectConformanceEntries(root, CONFORMANCE, true)).map(
    (entry) => entry.path,
  );
}

test("collecting conformance files refuses a symlink inside the tree", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "case.md");
    await replaceWithSymlink(
      `${root}/contracts/changelog-entry/conformance/cases/minimal.md`,
      secret,
    );
    await expect(
      collectConformanceEntries(root, CONFORMANCE, true),
    ).rejects.toThrow(ConfigError);
  });
});

test("a symlink under an ignored directory is still refused", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "case.md");
    await writeFile(`${root}/.gitignore`, "skipped/\n");
    await replaceWithSymlink(`${root}/${CONFORMANCE}/skipped/link.md`, secret);
    // Excluding a file from the digest is not a reason to stop looking at it:
    // the scan that refuses links has to see the whole tree.
    await expect(
      collectConformanceEntries(root, CONFORMANCE, true),
    ).rejects.toThrow(ConfigError);
  });
});

test("conformance framing matches its reference vector", async () => {
  // Framed by hand as 'path NUL size NUL bytes' and hashed with sha256sum.
  expect(
    await conformanceDigestOfEntries([
      { path: "a/x.txt", content: encoder.encode("XY") },
      { path: "b.txt", content: encoder.encode("B\n") },
    ]),
  ).toStrictEqual(
    "sha256:7bfb47738b94157bbf9d0b7de2a62a9c775f5bd67891dadf284be77d2bddea2e",
  );
});

test("conformance framing orders files by relative posix path", async () => {
  expect(
    await conformanceDigestOfEntries([
      { path: "b.txt", content: encoder.encode("B\n") },
      { path: "a/x.txt", content: encoder.encode("XY") },
    ]),
  ).toStrictEqual(
    "sha256:7bfb47738b94157bbf9d0b7de2a62a9c775f5bd67891dadf284be77d2bddea2e",
  );
});

test("conformance content is hashed as raw bytes, not canonicalized text", async () => {
  const lf = await conformanceDigestOfEntries([
    { path: "a.txt", content: encoder.encode("one\ntwo\n") },
  ]);
  const crlf = await conformanceDigestOfEntries([
    { path: "a.txt", content: encoder.encode("one\r\ntwo\r\n") },
  ]);
  expect(lf === crlf).toStrictEqual(false);
});

test("a file the tree's .gitignore matches is left out of the conformance digest", async () => {
  await withGoodTree(async (root) => {
    const before = await conformanceDigest(
      root,
      contractPath("changelog-entry"),
      "changelog-entry",
      true,
    );
    await writeFile(`${root}/.gitignore`, "*.pyc\n");
    await writeFile(`${root}/${CONFORMANCE}/cases/x.pyc`, "compiled bytes\n");
    expect(
      await conformanceDigest(
        root,
        contractPath("changelog-entry"),
        "changelog-entry",
        true,
      ),
    ).toStrictEqual(before);
  });
});

test("a rule in a .gitignore beside the files overrides the one above it", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/.gitignore`, "*.log\n");
    await writeFile(`${root}/${CONFORMANCE}/cases/.gitignore`, "!keep.log\n");
    await writeFile(`${root}/${CONFORMANCE}/cases/keep.log`, "kept\n");
    await writeFile(`${root}/${CONFORMANCE}/cases/drop.log`, "dropped\n");
    expect(await collectedPaths(root)).toStrictEqual([
      "cases/.gitignore",
      "cases/keep.log",
      "cases/minimal.md",
    ]);
  });
});

test("a file under an ignored directory stays out even where a deeper rule re-includes it", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/.gitignore`, "scratch/\n");
    await writeFile(`${root}/${CONFORMANCE}/scratch/.gitignore`, "!kept.md\n");
    await writeFile(`${root}/${CONFORMANCE}/scratch/kept.md`, "kept\n");
    expect(await collectedPaths(root)).toStrictEqual(["cases/minimal.md"]);
  });
});

test("a .gitignore in a directory between the root and the tests is obeyed", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/contracts/.gitignore`, "*.tmp\n");
    await writeFile(`${root}/${CONFORMANCE}/cases/draft.tmp`, "draft\n");
    expect(await collectedPaths(root)).toStrictEqual(["cases/minimal.md"]);
  });
});

test("changing what .gitignore matches changes the conformance digest", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/${CONFORMANCE}/cases/extra.md`, "one more case\n");
    const included = await conformanceDigest(
      root,
      contractPath("changelog-entry"),
      "changelog-entry",
      true,
    );
    await writeFile(`${root}/.gitignore`, "extra.md\n");
    const excluded = await conformanceDigest(
      root,
      contractPath("changelog-entry"),
      "changelog-entry",
      true,
    );
    expect(included === excluded).toStrictEqual(false);
  });
});

test("a conformance directory left empty by the exclusion counts as absent", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/.gitignore`, "*.pyc\n");
    await writeFile(
      `${root}/contracts/verdict-format/conformance/x.pyc`,
      "compiled bytes\n",
    );
    expect(
      await conformanceDigest(
        root,
        contractPath("verdict-format"),
        "verdict-format",
        true,
      ),
    ).toStrictEqual(null);
  });
});

test("a contract with no conformance directory has no conformance digest", async () => {
  await withGoodTree(async (root) => {
    expect(
      await conformanceDigest(
        root,
        contractPath("verdict-format"),
        "verdict-format",
        true,
      ),
    ).toStrictEqual(null);
  });
});

// Collecting a conformance tree keeps its own boundary, not the boundary of
// whichever command called it. Every command's way into a contract now refuses
// a planted link before reaching here, so this states the property that survives
// that: called on its own, this function still refuses rather than reading
// through. Left to the callers, the guarantee would hold only for as long as
// every one of them happens to look first.

test("a conformance tree reached through a symlinked parent is refused, never digested", async () => {
  await withGoodTree(async (root) => {
    // The link is one level above the conformance directory, so the directory
    // itself reads as an ordinary directory: what is refused has to be the way
    // down to it. Following it would hand back the bytes of a tree sitting
    // outside the boundary, as though this tree held them.
    const outside = await escapeThrough(root, "contracts/changelog-entry");
    const outsideBefore = await snapshotTree(outside);

    const error = await rejectedBy(
      () =>
        collectConformanceEntries(
          root,
          conformanceDirectory(
            contractPath("changelog-entry"),
            "changelog-entry",
          ),
          true,
        ),
      ConfigError,
    );
    expect(error.message).toContain(
      "symlink is not allowed inside the tree: contracts/changelog-entry/conformance",
    );
    expect(await snapshotTree(outside)).toStrictEqual(outsideBefore);
  });
});
