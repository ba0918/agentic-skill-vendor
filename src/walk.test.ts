import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import {
  atomicWriteFile,
  decodeUtf8,
  ensureParentDirectory,
  walkFiles,
} from "./walk.ts";
import {
  PERMISSIONS_APPLY,
  rejectedBy,
  replaceWithSymlink,
  runCli,
  snapshotTree,
  thrownBy,
  withEmptyDir,
  withGoodTree,
  withUnreadable,
  writeFile,
} from "./testing.ts";

const encoder = new TextEncoder();

/** A directory beside the tree, standing in for anything outside its boundary. */
function outsideOf(root: string): string {
  return `${root.slice(0, root.lastIndexOf("/"))}/outside`;
}

async function plantOutsideFile(root: string, name: string): Promise<string> {
  const path = `${outsideOf(root)}/${name}`;
  await writeFile(path, "content that must never be touched\n");
  return path;
}

test("walking refuses a directory holding a symlinked file", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "secret.md");
    await replaceWithSymlink(
      `${root}/skills/release-notes/references/vendor/changelog-entry.md`,
      secret,
    );
    const error = await rejectedBy(
      () => walkFiles(`${root}/skills`),
      ConfigError,
    );
    expect(error.message).toContain("changelog-entry.md");
  });
});

test("walking refuses a symlink whose target does not exist", async () => {
  await withGoodTree(async (root) => {
    await replaceWithSymlink(
      `${root}/skills/release-notes/references/vendor/changelog-entry.md`,
      `${outsideOf(root)}/nothing-here.md`,
    );
    await expect(walkFiles(`${root}/skills`)).rejects.toThrow(ConfigError);
  });
});

test("walking refuses a skill directory that is itself a symlink", async () => {
  await withGoodTree(async (root) => {
    const elsewhere = `${outsideOf(root)}/elsewhere`;
    await fs.mkdir(elsewhere, { recursive: true });
    await replaceWithSymlink(`${root}/skills/release-notes`, elsewhere);
    await expect(walkFiles(`${root}/skills`)).rejects.toThrow(ConfigError);
  });
});

test("a refused walk reads nothing through the symlink and changes nothing outside", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "secret.md");
    const outside = outsideOf(root);
    const before = await snapshotTree(outside);
    await replaceWithSymlink(
      `${root}/skills/review-writer/references/vendor/verdict-format.md`,
      secret,
    );
    await expect(walkFiles(`${root}/skills`)).rejects.toThrow(ConfigError);
    expect(await snapshotTree(outside)).toStrictEqual(before);
  });
});

test("an atomic write leaves no temporary file behind", async () => {
  await withEmptyDir(async (dir) => {
    await atomicWriteFile(dir, "out.md", encoder.encode("written\n"));
    const names = (await fs.readdir(dir)).sort();
    expect(names).toStrictEqual(["out.md"]);
    expect(await fs.readFile(`${dir}/out.md`, "utf8")).toStrictEqual(
      "written\n",
    );
  });
});

test("an atomic write replaces the previous content whole", async () => {
  await withEmptyDir(async (dir) => {
    await fs.writeFile(`${dir}/out.md`, "a much longer previous content\n");
    await atomicWriteFile(dir, "out.md", encoder.encode("short\n"));
    expect(await fs.readFile(`${dir}/out.md`, "utf8")).toStrictEqual("short\n");
  });
});

test("a write whose target is a directory fails and names the path", async () => {
  await withEmptyDir(async (dir) => {
    await fs.mkdir(`${dir}/out.md`);
    const error = await rejectedBy(
      () => atomicWriteFile(dir, "out.md", encoder.encode("written\n")),
      ConfigError,
    );
    expect(error.message).toContain("out.md");
  });
});

test("a parent directory is made for a name sitting at the tree root", async () => {
  await withEmptyDir(async (dir) => {
    // The name carries no separator, so a parent found by cutting at the last
    // one is the name with its final character removed: a directory beside the
    // file instead of the one holding it.
    await ensureParentDirectory(dir, "out.md");
    expect(await fs.readdir(dir)).toStrictEqual([]);
  });
});

test("a write refuses a symlink standing where the file belongs", async () => {
  await withGoodTree(async (root) => {
    // The rename would replace the link rather than follow it, so nothing
    // outside is overwritten — and that is exactly why nothing else catches
    // this. What is lost is the link itself, silently swapped for a file the
    // run wrote, which is a change to the tree nobody asked for.
    const secret = await plantOutsideFile(root, "target.md");
    const site = "skills/release-notes/note.md";
    await replaceWithSymlink(`${root}/${site}`, secret);

    const error = await rejectedBy(
      () => atomicWriteFile(root, site, encoder.encode("written\n")),
      ConfigError,
    );
    expect(error.message).toContain("refusing to write through a symlink");
    expect((await fs.lstat(`${root}/${site}`)).isSymbolicLink()).toStrictEqual(
      true,
    );
  });
});

test("a write that fails leaves no temporary file behind", async () => {
  await withEmptyDir(async (dir) => {
    // The bytes reach the temporary file and only the rename fails, so the
    // cleanup is the one thing standing between a failed run and a stray
    // sibling that every later listing of the directory has to explain.
    await fs.mkdir(`${dir}/out.md`);
    await expect(
      atomicWriteFile(dir, "out.md", encoder.encode("written\n")),
    ).rejects.toThrow(ConfigError);
    expect((await fs.readdir(dir)).sort()).toStrictEqual(["out.md"]);
  });
});

test("a write refuses a symlink pre-planted at its temporary path", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "manifest-target.json");
    const outside = outsideOf(root);
    const before = await snapshotTree(outside);
    const treeBefore = await snapshotTree(root);
    await replaceWithSymlink(`${root}/vendor-manifest.json.tmp`, secret);
    await expect(
      atomicWriteFile(root, "vendor-manifest.json", encoder.encode("{}\n")),
    ).rejects.toThrow(ConfigError);
    expect(await snapshotTree(outside)).toStrictEqual(before);
    const treeAfter = await snapshotTree(root);
    treeAfter.delete("vendor-manifest.json.tmp");
    expect(treeAfter).toStrictEqual(treeBefore);
  });
});

// The exit-code contract under a read that fails for a reason other than the
// file being absent. A permission error is the one that reaches a real tree:
// an absent file is an answer every reader here already has, and anything else
// means the run could not find out what the tree says, which is exit 2 on
// standard error rather than an exception escaping as a stack trace.
//
// The counterpart on the writing side has been stated since the beginning. The
// reading side had nothing, which is how these survived.

const describeRead = PERMISSIONS_APPLY ? test : test.skip;

describeRead(
  "a directory the run may not list is a configuration error, not a crash",
  async () => {
    await withGoodTree(async (root) => {
      await withUnreadable(`${root}/skills`, async () => {
        const result = await runCli(["verify", "--root", root]);
        expect(result.code).toStrictEqual(2);
        expect(result.stdout).toStrictEqual([]);
        expect(result.stderr.join("\n")).toContain("skills");
      });
    });
  },
);

describeRead(
  "a vendored copy the run may not read is a configuration error, not a crash",
  async () => {
    await withGoodTree(async (root) => {
      const copy = "skills/review-writer/references/vendor/verdict-format.md";
      await withUnreadable(`${root}/${copy}`, async () => {
        const result = await runCli(["verify", "--root", root]);
        expect(result.code).toStrictEqual(2);
        expect(result.stdout).toStrictEqual([]);
        expect(result.stderr.join("\n")).toContain(copy);
      });
    });
  },
);

describeRead(
  "a conformance file the run may not read is a configuration error, not a crash",
  async () => {
    await withGoodTree(async (root) => {
      const site = "contracts/changelog-entry/conformance/cases/minimal.md";
      await withUnreadable(`${root}/${site}`, async () => {
        const result = await runCli(["verify", "--root", root]);
        expect(result.code).toStrictEqual(2);
        expect(result.stdout).toStrictEqual([]);
        expect(result.stderr.join("\n")).toContain("minimal.md");
      });
    });
  },
);

describeRead(
  "a file inside a skill the linter may not read is a configuration error, not a crash",
  async () => {
    await withGoodTree(async (root) => {
      const site = "skills/review-writer/SKILL.md";
      await withUnreadable(`${root}/${site}`, async () => {
        const result = await runCli(["lint-selfcontain", "--root", root]);
        expect(result.code).toStrictEqual(2);
        expect(result.stdout).toStrictEqual([]);
        expect(result.stderr.join("\n")).toContain("SKILL.md");
      });
    });
  },
);

test("content that is not valid UTF-8 is a configuration error naming the file", () => {
  const error = thrownBy(
    () => decodeUtf8(new Uint8Array([0x41, 0xff, 0xfe]), "contracts/broken.md"),
    ConfigError,
  );
  expect(error.message).toContain("contracts/broken.md");
});
