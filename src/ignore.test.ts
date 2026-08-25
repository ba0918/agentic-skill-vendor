import { expect, test } from "bun:test";
import {
  ancestorDirectories,
  readIgnoreRules,
  treeDirectoryOf,
} from "./ignore.ts";
import { withEmptyDir, writeFile } from "./test-support/testing.ts";

/**
 * Builds a tree from a path-to-content map and answers what the rules in it
 * exclude, asked from the deepest directory named.
 */
async function excludedIn(
  files: Record<string, string>,
  from: string,
  paths: string[],
): Promise<string[]> {
  return await withEmptyDir(async (root) => {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(`${root}/${path}`, content);
    }
    // Every directory holding a .gitignore is offered to the rules, not only
    // the ancestors of `from`. A nested rule the reader never loaded cannot be
    // shown to lose to the rule above it.
    const directories = [
      ...ancestorDirectories(from),
      ...Object.keys(files)
        .filter((path) => path.endsWith(".gitignore"))
        .map((path) => treeDirectoryOf(path)),
    ];
    const rules = await readIgnoreRules(root, directories);
    return paths.filter((path) => rules.excludes(path));
  });
}

test("a tree with no .gitignore anywhere excludes nothing", async () => {
  expect(
    await excludedIn({ "a/b/note.md": "text\n" }, "a/b", ["a/b/note.md"]),
  ).toStrictEqual([]);
});

test("a rule at the tree root reaches a file any number of levels down", async () => {
  expect(
    await excludedIn({ ".gitignore": "*.log\n" }, "a/b", [
      "a/b/run.log",
      "a/b/note.md",
    ]),
  ).toStrictEqual(["a/b/run.log"]);
});

test("a rule is read relative to the directory its .gitignore sits in", async () => {
  // `notes.md` under a/ names a file directly beside that .gitignore, so a file
  // of the same name one level deeper is not the one the rule names.
  expect(
    await excludedIn({ "a/.gitignore": "/notes.md\n" }, "a/b", [
      "a/notes.md",
      "a/b/notes.md",
    ]),
  ).toStrictEqual(["a/notes.md"]);
});

test("a rule closer to the file wins over one further up", async () => {
  expect(
    await excludedIn(
      { ".gitignore": "*.log\n", "a/b/.gitignore": "!keep.log\n" },
      "a/b",
      ["a/b/keep.log", "a/b/drop.log"],
    ),
  ).toStrictEqual(["a/b/drop.log"]);
});

test("a rule naming a directory excludes everything beneath it", async () => {
  expect(
    await excludedIn({ ".gitignore": "cache/\n" }, "a", [
      "a/cache/one.txt",
      "a/cache/deep/two.txt",
      "a/cached.txt",
    ]),
  ).toStrictEqual(["a/cache/one.txt", "a/cache/deep/two.txt"]);
});

test("a file under an excluded directory is not brought back by a deeper rule", async () => {
  // Git never looks inside a directory it excluded, so a rule written under one
  // has nothing to re-include.
  expect(
    await excludedIn(
      { ".gitignore": "cache/\n", "a/cache/.gitignore": "!kept.txt\n" },
      "a",
      ["a/cache/kept.txt"],
    ),
  ).toStrictEqual(["a/cache/kept.txt"]);
});
