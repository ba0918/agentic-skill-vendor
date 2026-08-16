import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirNameOf } from "../src/vendor.ts";
import {
  replaceWithSymlink,
  runCli,
  withGoodTree,
  writeFile,
} from "../src/testing.ts";

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

Deno.test("a self-contained tree passes with no violations", async () => {
  await withGoodTree(async (root) => {
    const result = await lint(root);
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("a reference above the skill directory is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "See ../other-skill/thing.md\n",
    );
    assertEquals(result.code, 1);
    assertEquals(kindsOf(result.stdout), ["parent-escape"]);
  });
});

Deno.test("a windows-style reference above the skill directory is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "See ..\\other\\thing.md\n",
    );
    assertEquals(kindsOf(result.stdout), ["parent-escape"]);
  });
});

Deno.test("an absolute path reference is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(root, "notes.md", "Read /etc/hosts first.\n");
    assertEquals(kindsOf(result.stdout), ["absolute-path"]);
    assertStringIncludes(result.stdout[0], "/etc/hosts");
  });
});

Deno.test("an absolute path is detected directly after a comma or a semicolon", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "paths,/opt/tools/a\nmore;/opt/tools/b\n",
    );
    assertEquals(kindsOf(result.stdout), ["absolute-path", "absolute-path"]);
  });
});

Deno.test("a home directory reference is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "Config lives in ~/.config/app\n",
    );
    assertEquals(kindsOf(result.stdout), ["absolute-path"]);
  });
});

Deno.test("a windows drive reference is detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "Logs are under C:\\app\\logs\\run.txt today.\n",
    );
    assertEquals(kindsOf(result.stdout), ["absolute-path"]);
  });
});

Deno.test("a single segment after a slash is not an absolute path reference", async () => {
  await withGoodTree(async (root) => {
    // Prose such as a slash command must not be mistaken for a path.
    const result = await lintWith(
      root,
      "notes.md",
      "Run /help to see the list.\n",
    );
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("a URL is not treated as a path reference", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "See [the docs](https://example.com/guide/setup) for setup.\n",
    );
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("a shebang naming an interpreter is not a path reference", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "run.sh",
      '#!/usr/bin/env bash\necho "self-contained"\n',
    );
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("an absolute path after the shebang interpreter is still detected", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "run.sh",
      "#!/usr/bin/env bash /opt/tools/wrapper.sh\necho hi\n",
    );
    assertEquals(kindsOf(result.stdout), ["absolute-path"]);
    assertStringIncludes(result.stdout[0], "/opt/tools/wrapper.sh");
  });
});

Deno.test("the shebang exemption covers the first line only", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "run.sh",
      "#!/usr/bin/env bash\n#! /opt/tools/other.sh\n",
    );
    assertEquals(kindsOf(result.stdout), ["absolute-path"]);
    assertStringIncludes(result.stdout[0], "run.sh:2");
  });
});

Deno.test("every violation names the file and the line it sits on", async () => {
  await withGoodTree(async (root) => {
    const result = await lintWith(
      root,
      "notes.md",
      "clean line\nSee ../elsewhere\n",
    );
    assertStringIncludes(result.stdout[0], "skills/release-notes/notes.md:2");
  });
});

Deno.test("a file that is not valid UTF-8 is still scanned to its last line", async () => {
  await withGoodTree(async (root) => {
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode("# Notes\n"),
      0xff,
      ...encoder.encode("\nSee ../elsewhere for details\n"),
    ]);
    const result = await lintWith(root, "notes.md", bytes);
    assertEquals(kindsOf(result.stdout), ["parent-escape"]);
    assertStringIncludes(result.stdout[0], "notes.md:3");
  });
});

Deno.test("a symlink resolving outside its skill directory is detected", async () => {
  await withGoodTree(async (root) => {
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await writeFile(`${outside}/secret.md`, "elsewhere\n");
    await replaceWithSymlink(
      `${root}/skills/release-notes/linked.md`,
      `${outside}/secret.md`,
    );
    const result = await lint(root);
    assertEquals(result.code, 1);
    assertEquals(kindsOf(result.stdout), ["symlink-escape"]);
  });
});

Deno.test("a skill directory that is itself an outward symlink is detected", async () => {
  await withGoodTree(async (root) => {
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await Deno.mkdir(outside, { recursive: true });
    await replaceWithSymlink(`${root}/skills/release-notes`, outside);
    assertEquals(kindsOf((await lint(root)).stdout), ["symlink-escape"]);
  });
});

Deno.test("a symlink resolving inside the same skill directory passes", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/skills/release-notes/target.md`, "inside\n");
    await replaceWithSymlink(
      `${root}/skills/release-notes/alias.md`,
      `${root}/skills/release-notes/target.md`,
    );
    const result = await lint(root);
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("files outside the skills directory are not linted", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/contracts/notes.md`, "See ../elsewhere\n");
    const result = await lint(root);
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("linting a tree with no skills directory is a usage error", async () => {
  await withGoodTree(async (root) => {
    await Deno.remove(`${root}/skills`, { recursive: true });
    const result = await lint(root);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
  });
});

Deno.test("the directory of a path naming no directory is the current one", () => {
  // A link target is resolved against the directory its link sits in. When that
  // path names no directory at all, the answer is the current directory, not
  // the path with its last character cut off.
  assertEquals(
    dirNameOf("skills/release-notes/notes.md"),
    "skills/release-notes",
  );
  assertEquals(dirNameOf("notes.md"), ".");
});
