import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError } from "./errors.ts";
import {
  atomicWriteFile,
  decodeUtf8,
  ensureParentDirectory,
  isDirectoryOrAbsent,
  isRegularFileOrAbsent,
  readEntries,
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
        expect(result.stderr.join("\n")).toContain("cannot read skills");
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

// One spelling for every path a message names: the one the tree uses. A reader
// holding the same checkout can find any of them, and the same file no longer
// reads as two different paths depending on which call happened to fail on it.
//
// Each case asserts the message up to and including the path, because that is
// what tells the two spellings apart: the absolute form puts the tree's own
// location between the verb and the path, so the fragment below is absent from
// it however the message ends.

describeRead(
  "a file whose kind cannot be read is named as the tree spells it",
  async () => {
    await withGoodTree(async (root) => {
      const site = "skills/review-writer/references/vendor/verdict-format.md";
      const vendor = "skills/review-writer/references/vendor";
      await withUnreadable(`${root}/${vendor}`, async () => {
        const error = await rejectedBy(
          () => isRegularFileOrAbsent(root, site),
          ConfigError,
        );
        expect(error.message).toContain(`cannot inspect ${site}`);
      });
    });
  },
);

describeRead(
  "a directory whose kind cannot be read is named as the tree spells it",
  async () => {
    await withGoodTree(async (root) => {
      const site = "skills/review-writer/references/vendor";
      await withUnreadable(
        `${root}/skills/review-writer/references`,
        async () => {
          const error = await rejectedBy(
            () => isDirectoryOrAbsent(root, site),
            ConfigError,
          );
          expect(error.message).toContain(`cannot inspect ${site}`);
        },
      );
    });
  },
);

describeRead(
  "an entry of a directory that lists but cannot be searched is named as the tree spells it",
  async () => {
    await withGoodTree(async (root) => {
      // Readable and not searchable: the names come back and every stat under
      // them fails, which is the half of the listing that speaks for itself.
      const site = "skills/review-writer/references/vendor";
      const path = `${root}/${site}`;
      const { mode } = await fs.stat(path);
      await fs.chmod(path, 0o444);
      try {
        const error = await rejectedBy(
          () => readEntries(path, site),
          ConfigError,
        );
        expect(error.message).toContain(`cannot inspect ${site}/`);
      } finally {
        await fs.chmod(path, mode);
      }
    });
  },
);

describeRead(
  "a vendor directory gen may not list is named as the tree spells it",
  async () => {
    await withGoodTree(async (root) => {
      const site = "skills/release-notes/references/vendor";
      await withUnreadable(`${root}/${site}`, async () => {
        const result = await runCli(["gen", "--root", root]);
        expect(result.code).toStrictEqual(2);
        expect(result.stderr.join("\n")).toContain(`cannot read ${site}`);
      });
    });
  },
);

describeRead(
  "a directory the linter may not list is named as the tree spells it",
  async () => {
    await withGoodTree(async (root) => {
      const site = "skills/release-notes/references";
      await withUnreadable(`${root}/${site}`, async () => {
        const result = await runCli(["lint-selfcontain", "--root", root]);
        expect(result.code).toStrictEqual(2);
        expect(result.stderr.join("\n")).toContain(`cannot read ${site}`);
      });
    });
  },
);

test("a symlink found inside a conformance tree is named as the tree spells it", async () => {
  await withGoodTree(async (root) => {
    const site = "contracts/changelog-entry/conformance/cases/escape.md";
    await replaceWithSymlink(
      `${root}/${site}`,
      await plantOutsideFile(root, "secret.md"),
    );

    const result = await runCli(["verify", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain(
      `symlink is not allowed inside a scanned tree: ${site}`,
    );
  });
});

test("content that is not valid UTF-8 is a configuration error naming the file", () => {
  const error = thrownBy(
    () => decodeUtf8(new Uint8Array([0x41, 0xff, 0xfe]), "contracts/broken.md"),
    ConfigError,
  );
  expect(error.message).toContain("contracts/broken.md");
});

// The kinds a tree is expected to hold, and what happens when it holds
// something else. Asked as a plain "is it a directory" or "is it a file", every
// one of these paths answered no exactly as an absent path does, and the branch
// written for "nothing there yet" ran on a tree that held something: a regular
// file at skills/ emptied the lock of every dependency while gen reported 0.
//
// `refusal` is the message where the kind is what stops all three commands.
// Where a command reaches the path by writing to it instead, it stops on that
// write, so only the exit code is shared.

const WRONG_KIND_SITES: {
  site: string;
  expected: "directory" | "file";
  refusal: string | null;
}[] = [
  { site: "skills", expected: "directory", refusal: "skills: not a directory" },
  {
    site: "skills/release-notes/references/vendor",
    expected: "directory",
    refusal: "vendor: not a directory",
  },
  {
    site: "contracts/changelog-entry/conformance",
    expected: "directory",
    refusal: "conformance: not a directory",
  },
  {
    site: "skills/review-writer/SKILL.md",
    expected: "file",
    refusal: "SKILL.md: not a regular file",
  },
  {
    site: "contracts/verdict-format.md",
    expected: "file",
    refusal: "contracts/verdict-format.md: not a regular file",
  },
  { site: "vendor-manifest.json", expected: "file", refusal: null },
  {
    site: "skills/review-writer/references/vendor/verdict-format.md",
    expected: "file",
    refusal: null,
  },
];

const READING_COMMANDS = [["gen"], ["verify"], ["accept", "changelog-entry"]];

test("a path holding the wrong kind of thing is refused by every command", async () => {
  for (const { site, expected, refusal } of WRONG_KIND_SITES) {
    await withGoodTree(async (root) => {
      await fs.rm(`${root}/${site}`, { recursive: true });
      if (expected === "directory") {
        await fs.writeFile(`${root}/${site}`, "not a directory\n");
      } else {
        await fs.mkdir(`${root}/${site}`);
      }
      const before = await snapshotTree(root);

      for (const command of READING_COMMANDS) {
        const where = `${site} / ${command[0]}`;
        const result = await runCli([...command, "--root", root]);
        expect(result.code, where).toStrictEqual(2);
        expect(result.stdout, where).toStrictEqual([]);
        if (refusal !== null) {
          expect(result.stderr.join("\n"), where).toContain(refusal);
        }
      }
      expect(await snapshotTree(root), site).toStrictEqual(before);
    });
  }
});

test("a named pipe standing where a directory belongs is refused as a kind", async () => {
  await withGoodTree(async (root) => {
    // The kind is read from the entry, never by opening it: a pipe opened for
    // reading blocks until something on the other side writes.
    await fs.rm(`${root}/skills`, { recursive: true });
    await promisify(execFile)("mkfifo", [`${root}/skills`]);

    const result = await runCli(["verify", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain("skills: not a directory");
  });
});

test("a tree holding none of the optional paths is a tree, not a refusal", async () => {
  await withEmptyDir(async (root) => {
    // What every one of these refusals must not touch. A tree with no skills/
    // at all is where a repository starts, and the answers below are what let
    // it be adopted: nothing is declared, so nothing is vendored, and the
    // manifest that gets written says exactly that.
    expect((await runCli(["gen", "--root", root])).code).toStrictEqual(0);
    const verified = await runCli(["verify", "--root", root]);
    expect(verified.code, verified.stdout.join("\n")).toStrictEqual(0);
    expect(
      JSON.parse(await fs.readFile(`${root}/vendor-manifest.json`, "utf8"))
        .lock,
    ).toStrictEqual({ dependencies: {}, resolutions: {} });
  });
});
