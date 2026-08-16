import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { dirNameOf } from "./lint.ts";
import {
  replaceWithSymlink,
  runCli,
  withGoodTree,
  writeFile,
} from "./testing.ts";

async function lint(root: string) {
  return await runCli(["lint-selfcontain", "--root", root]);
}

/** Puts one file inside a skill and lints the tree. */
async function lintWith(
  root: string,
  name: string,
  content: string | Uint8Array,
) {
  await writeFile(`${root}/skills/release-notes/${name}`, content);
  return await lint(root);
}

function kindsOf(lines: string[]): string[] {
  return lines.map((line) => line.slice(0, line.indexOf(":"))).sort();
}

test("a self-contained tree passes with no violations", async () => {
  await withGoodTree(async (root) => {
    const result = await lint(root);
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("a reference above the skill directory is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "See ../other-skill/thing.md\n",
    );
    expect(result.code).toStrictEqual(1);
    expect(kindsOf(result.stdout)).toStrictEqual(["parent-escape"]);
  });
});

test("a windows-style reference above the skill directory is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "See ..\\other\\thing.md\n",
    );
    expect(kindsOf(result.stdout)).toStrictEqual(["parent-escape"]);
  });
});

test("an absolute path reference is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(root, "notes.md", "Read /etc/hosts first.\n");
    expect(kindsOf(result.stdout)).toStrictEqual(["absolute-path"]);
    expect(result.stdout[0]).toContain("/etc/hosts");
  });
});

test("an absolute path is detected directly after a comma or a semicolon", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "paths,/opt/tools/a\nmore;/opt/tools/b\n",
    );
    expect(kindsOf(result.stdout)).toStrictEqual([
      "absolute-path",
      "absolute-path",
    ]);
  });
});

test("a home directory reference is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "Config lives in ~/.config/app\n",
    );
    expect(kindsOf(result.stdout)).toStrictEqual(["absolute-path"]);
  });
});

test("a windows drive reference is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "Logs are under C:\\app\\logs\\run.txt today.\n",
    );
    expect(kindsOf(result.stdout)).toStrictEqual(["absolute-path"]);
  });
});

test("a single segment after a slash is not an absolute path reference", async () => {
  await withGoodTree(async (root) => {
    // Prose such as a slash command must not be mistaken for a path.
    const result = await lintWith(
      root,
      "notes.md",
      "Run /help to see the list.\n",
    );
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("a URL is not treated as a path reference", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "See [the docs](https://example.com/guide/setup) for setup.\n",
    );
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("a shebang naming an interpreter is not a path reference", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "run.sh",
      '#!/usr/bin/env bash\necho "self-contained"\n',
    );
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("an absolute path after the shebang interpreter is still detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "run.sh",
      "#!/usr/bin/env bash /opt/tools/wrapper.sh\necho hi\n",
    );
    expect(kindsOf(result.stdout)).toStrictEqual(["absolute-path"]);
    expect(result.stdout[0]).toContain("/opt/tools/wrapper.sh");
  });
});

test("the shebang exemption covers the first line only", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "run.sh",
      "#!/usr/bin/env bash\n#! /opt/tools/other.sh\n",
    );
    expect(kindsOf(result.stdout)).toStrictEqual(["absolute-path"]);
    expect(result.stdout[0]).toContain("run.sh:2");
  });
});

test("every violation names the file and the line it sits on", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "clean line\nSee ../elsewhere\n",
    );
    expect(result.stdout[0]).toContain("skills/release-notes/notes.md:2");
  });
});

test("a file that is not valid UTF-8 is still scanned to its last line", async () => {
  await withGoodTree(async (root) => {
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode("# Notes\n"),
      0xff,
      ...encoder.encode("\nSee ../elsewhere for details\n"),
    ]);
    const result = await lintWith(root, "notes.md", bytes);
    expect(kindsOf(result.stdout)).toStrictEqual(["parent-escape"]);
    expect(result.stdout[0]).toContain("notes.md:3");
  });
});

test("a symlink resolving outside its skill directory is detected", async () => {
  await withGoodTree(async (root) => {
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await writeFile(`${outside}/secret.md`, "elsewhere\n");
    await replaceWithSymlink(
      `${root}/skills/release-notes/linked.md`,
      `${outside}/secret.md`,
    );
    const result = await lint(root);
    expect(result.code).toStrictEqual(1);
    expect(kindsOf(result.stdout)).toStrictEqual(["symlink-escape"]);
  });
});

test("a skill directory that is itself an outward symlink is detected", async () => {
  await withGoodTree(async (root) => {
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await fs.mkdir(outside, { recursive: true });
    await replaceWithSymlink(`${root}/skills/release-notes`, outside);
    expect(kindsOf((await lint(root)).stdout)).toStrictEqual([
      "symlink-escape",
    ]);
  });
});

test("a symlink resolving inside the same skill directory passes", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/skills/release-notes/target.md`, "inside\n");
    await replaceWithSymlink(
      `${root}/skills/release-notes/alias.md`,
      `${root}/skills/release-notes/target.md`,
    );
    const result = await lint(root);
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("files outside the skills directory are not linted", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/contracts/notes.md`, "See ../elsewhere\n");
    const result = await lint(root);
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("linting a tree with no skills directory is a usage error", async () => {
  await withGoodTree(async (root) => {
    await fs.rm(`${root}/skills`, { recursive: true });
    const result = await lint(root);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
  });
});

test("the directory of a path naming no directory is the current one", () => {
  // A link target is resolved against the directory its link sits in. When that
  // path names no directory at all, the answer is the current directory, not
  // the path with its last character cut off.
  expect(dirNameOf("skills/release-notes/notes.md")).toStrictEqual(
    "skills/release-notes",
  );
  expect(dirNameOf("notes.md")).toStrictEqual(".");
});
