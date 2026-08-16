import { assertEquals } from "@std/assert";
import { ancestorDirectories, readIgnoreRules } from "./ignore.ts";
import { withEmptyDir, writeFile } from "./testing.ts";

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
    const rules = await readIgnoreRules(root, ancestorDirectories(from));
    return paths.filter((path) => rules.excludes(path));
  });
}

Deno.test("a tree with no .gitignore anywhere excludes nothing", async () => {
  assertEquals(
    await excludedIn({ "a/b/note.md": "text\n" }, "a/b", ["a/b/note.md"]),
    [],
  );
});

Deno.test("a rule at the tree root reaches a file any number of levels down", async () => {
  assertEquals(
    await excludedIn({ ".gitignore": "*.log\n" }, "a/b", [
      "a/b/run.log",
      "a/b/note.md",
    ]),
    ["a/b/run.log"],
  );
});

Deno.test("a rule is read relative to the directory its .gitignore sits in", async () => {
  // `notes.md` under a/ names a file directly beside that .gitignore, so a file
  // of the same name one level deeper is not the one the rule names.
  assertEquals(
    await excludedIn({ "a/.gitignore": "/notes.md\n" }, "a/b", [
      "a/notes.md",
      "a/b/notes.md",
    ]),
    ["a/notes.md"],
  );
});

Deno.test("a rule closer to the file wins over one further up", async () => {
  assertEquals(
    await excludedIn(
      { ".gitignore": "*.log\n", "a/b/.gitignore": "!keep.log\n" },
      "a/b",
      [
        "a/b/keep.log",
        "a/b/drop.log",
      ],
    ),
    ["a/b/drop.log"],
  );
});

Deno.test("a rule naming a directory excludes everything beneath it", async () => {
  assertEquals(
    await excludedIn({ ".gitignore": "cache/\n" }, "a", [
      "a/cache/one.txt",
      "a/cache/deep/two.txt",
      "a/cached.txt",
    ]),
    ["a/cache/one.txt", "a/cache/deep/two.txt"],
  );
});

Deno.test("a file under an excluded directory is not brought back by a deeper rule", async () => {
  // Git never looks inside a directory it excluded, so a rule written under one
  // has nothing to re-include.
  assertEquals(
    await excludedIn(
      { ".gitignore": "cache/\n", "a/cache/.gitignore": "!kept.txt\n" },
      "a",
      ["a/cache/kept.txt"],
    ),
    ["a/cache/kept.txt"],
  );
});
