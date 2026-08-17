import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError } from "./errors.ts";
import { canonicalJson, readLock, type Resolutions } from "./manifest.ts";
import { runCli, snapshotTree, withEmptyDir, withGoodTree } from "./testing.ts";

const MANIFEST = "vendor-manifest.json";

// deno-lint-ignore no-explicit-any
type Json = any;

async function readManifest(root: string): Promise<Json> {
  return JSON.parse(await fs.readFile(`${root}/${MANIFEST}`, "utf8"));
}

test("the manifest keeps dependencies and resolutions apart", async () => {
  await withGoodTree(async (root) => {
    const lock = (await readManifest(root)).lock;
    expect(lock.dependencies["review-writer"]).toStrictEqual([
      "changelog-entry",
      "verdict-format",
    ]);
    expect(lock.dependencies["release-notes"]).toStrictEqual([
      "changelog-entry",
    ]);
    expect(lock.resolutions["verdict-format"].digest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});

test("the manifest locks a conformance digest only for a contract shipping tests", async () => {
  await withGoodTree(async (root) => {
    const resolutions = (await readManifest(root)).lock.resolutions;
    expect(resolutions["changelog-entry"].conformance).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect("conformance" in resolutions["verdict-format"]).toStrictEqual(false);
  });
});

test("the manifest records no wall-clock timestamp", async () => {
  await withGoodTree(async (root) => {
    const text = await fs.readFile(`${root}/${MANIFEST}`, "utf8");
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)).toStrictEqual(false);
  });
});

test("the manifest names where the tool and each contract came from", async () => {
  await withGoodTree(async (root) => {
    const provenance = (await readManifest(root)).provenance;
    expect(provenance.generator.name).toStrictEqual("agentic-skill-vendor");
    expect(provenance.generator.source).toContain("github.com");
    expect(provenance.contracts["verdict-format"].source).toStrictEqual(
      "contracts/verdict-format.md",
    );
  });
});

test("provenance names only the contracts whose canonical text is present", async () => {
  await withGoodTree(async (root) => {
    // The contract is withdrawn: no skill declares it any more and the
    // canonical file is gone. The resolution it was accepted under stays in the
    // lock, because accept is the only thing that writes resolutions.
    const skill = `${root}/skills/review-writer/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace("    - verdict-format\n", ""),
    );
    await fs.rm(`${root}/contracts/verdict-format.md`);

    const result = await runCli(["gen", "--root", root]);
    expect(
      result.code,
      result.stdout.concat(result.stderr).join("\n"),
    ).toStrictEqual(0);
    const provenance = (await readManifest(root)).provenance;
    expect("verdict-format" in provenance.contracts).toStrictEqual(false);
    expect(provenance.contracts["changelog-entry"].source).toStrictEqual(
      "contracts/changelog-entry.md",
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("provenance refuses a contracts directory symlinked outside the tree", async () => {
  await withGoodTree(async (root) => {
    // Every skill is stripped of its declarations, so nothing on the way to
    // provenance has looked at contracts/ yet: the resolutions are read from
    // the lock, and their source paths would be recorded as though the tree
    // held the files they name.
    for (const name of ["release-notes", "review-writer"]) {
      await fs.writeFile(
        `${root}/skills/${name}/SKILL.md`,
        `---\nname: ${name}\n---\n\n# ${name}\n`,
      );
    }
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await fs.mkdir(outside, { recursive: true });
    await fs.rename(`${root}/contracts`, `${outside}/contracts`);
    await fs.symlink(`${outside}/contracts`, `${root}/contracts`);

    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain(
      "symlink is not allowed inside the tree: contracts",
    );
    // Named as the file whose provenance was about to be recorded, not as the
    // conformance directory, which is checked on the same way in and which the
    // tree need not even hold. Which contract is reached first does not matter,
    // so none is named.
    expect(result.stderr.join("\n")).toMatch(
      /symlink is not allowed inside the tree: contracts\/[^\s]+\.md/,
    );
  });
});

test("provenance refuses a contract's own directory symlinked outside the tree", async () => {
  await withGoodTree(async (root) => {
    // The contract that no skill declares any more: reading the canonical text
    // never reaches it, so the lock is the one thing still naming it and
    // provenance is the only route left to contracts/. Refused for the same
    // contract still declared, the link stopped every command; refused only
    // there, this one shape went on answering three different ways.
    for (const name of ["release-notes", "review-writer"]) {
      await fs.writeFile(
        `${root}/skills/${name}/SKILL.md`,
        `---\nname: ${name}\n---\n\n# ${name}\n`,
      );
    }
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await fs.mkdir(outside, { recursive: true });
    await fs.rename(
      `${root}/contracts/changelog-entry`,
      `${outside}/changelog-entry`,
    );
    await fs.symlink(
      `${outside}/changelog-entry`,
      `${root}/contracts/changelog-entry`,
    );
    const outsideBefore = await snapshotTree(outside);

    for (const command of [["gen"], ["verify"], ["accept", "verdict-format"]]) {
      const result = await runCli([...command, "--root", root]);
      expect(result.code, command[0]).toStrictEqual(2);
      expect(result.stdout, command[0]).toStrictEqual([]);
      expect(result.stderr.join("\n"), command[0]).toContain(
        "symlink is not allowed inside the tree: contracts/changelog-entry",
      );
    }
    expect(await snapshotTree(outside)).toStrictEqual(outsideBefore);
  });
});

// The lock is read back from a file anyone can edit, and a resolution key
// becomes a path under contracts/. These state what the reader refuses.

/** Writes `manifest` as the tree's manifest and reads the resolutions back. */
async function readWritten(manifest: string): Promise<Resolutions> {
  return await withEmptyDir(async (root) => {
    await fs.writeFile(`${root}/${MANIFEST}`, manifest);
    return (await readLock(root)).resolutions;
  });
}

function manifestWith(resolutions: string): string {
  return `{"lock":{"resolutions":${resolutions}}}`;
}

const DIGEST = `sha256:${"0".repeat(64)}`;

test("a tree with no manifest has no resolutions", async () => {
  expect(
    await withEmptyDir(async (root) => (await readLock(root)).resolutions),
  ).toStrictEqual({});
});

test("a recorded resolution is read back whole", async () => {
  expect(
    await readWritten(
      manifestWith(
        `{"verdict-format":{"digest":"${DIGEST}","version":"1.2.0"}}`,
      ),
    ),
  ).toStrictEqual({ "verdict-format": { digest: DIGEST, version: "1.2.0" } });
});

test("a resolution key that would escape the contracts directory is refused", async () => {
  await expect(
    readWritten(manifestWith(`{"../../etc/passwd":{"digest":"${DIGEST}"}}`)),
  ).rejects.toThrow(ConfigError);
});

test("a resolution whose digest is not a sha256 digest is refused", async () => {
  await expect(
    readWritten(manifestWith(`{"verdict-format":{"digest":"notadigest"}}`)),
  ).rejects.toThrow(ConfigError);
});

test("a resolution whose version is not text is refused", async () => {
  await expect(
    readWritten(
      manifestWith(`{"verdict-format":{"digest":"${DIGEST}","version":1}}`),
    ),
  ).rejects.toThrow(ConfigError);
});

test("a lock that is not an object is refused", async () => {
  await expect(readWritten(`{"lock":"oops"}`)).rejects.toThrow(ConfigError);
});

test("resolutions written as a list are refused", async () => {
  await expect(readWritten(manifestWith(`["verdict-format"]`))).rejects.toThrow(
    ConfigError,
  );
});

test("a manifest that is not readable JSON is refused", async () => {
  await expect(readWritten(`{"lock":{`)).rejects.toThrow(ConfigError);
});

test("provenance refuses a contract file that is there but is not a regular file", async () => {
  await withGoodTree(async (root) => {
    // The contract no skill declares any more: reading canonical text never
    // reaches it, so provenance is the only route left to it. A directory
    // standing where its text belongs answered exactly as text that is not
    // there does, and the contract dropped out of provenance without a word —
    // gen finished at 0 and verify called the result clean.
    for (const name of ["release-notes", "review-writer"]) {
      await fs.writeFile(
        `${root}/skills/${name}/SKILL.md`,
        `---\nname: ${name}\n---\n\n# ${name}\n`,
      );
    }
    await fs.rm(`${root}/contracts/verdict-format.md`);
    await fs.mkdir(`${root}/contracts/verdict-format.md`);
    const before = await snapshotTree(root);

    for (const command of [
      ["gen"],
      ["verify"],
      ["accept", "changelog-entry"],
    ]) {
      const result = await runCli([...command, "--root", root]);
      expect(result.code, command[0]).toStrictEqual(2);
      expect(result.stdout, command[0]).toStrictEqual([]);
      expect(result.stderr.join("\n"), command[0]).toContain(
        "contracts/verdict-format.md: not a regular file",
      );
    }
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});

test("a manifest that is a named pipe is refused rather than opened", async () => {
  await withGoodTree(async (root) => {
    // The lock is read before anything else a command does, and it was read
    // without asking what stands at the path. Opening a pipe to read blocks
    // until something on the other side writes: measured before this was
    // closed, all three commands ran on without ever returning.
    await fs.rm(`${root}/${MANIFEST}`);
    await promisify(execFile)("mkfifo", [`${root}/${MANIFEST}`]);

    for (const command of [
      ["gen"],
      ["verify"],
      ["accept", "changelog-entry"],
    ]) {
      const result = await runCli([...command, "--root", root]);
      expect(result.code, command[0]).toStrictEqual(2);
      expect(result.stdout, command[0]).toStrictEqual([]);
      expect(result.stderr.join("\n"), command[0]).toContain(
        `${MANIFEST}: not a regular file`,
      );
    }
  });
});

test("the canonical rendering keeps a key that names a prototype", async () => {
  // Sorting rebuilds every object it renders, and rebuilding is where the key
  // is lost: assigned into a plain object it writes the prototype instead. A
  // manifest read back and rendered again would silently shed the entry.
  const parsed = JSON.parse(
    '{"lock":{"dependencies":{"__proto__":["a"],"z":["b"]}}}',
  );
  const rendered = canonicalJson(parsed);
  expect(rendered).toContain('"__proto__"');
  expect(
    Object.getOwnPropertyDescriptor(
      JSON.parse(rendered).lock.dependencies,
      "__proto__",
    )?.value,
  ).toStrictEqual(["a"]);
});

test("a lock recording a skill named for a prototype key reads it back", async () => {
  await withEmptyDir(async (root) => {
    await fs.writeFile(
      `${root}/${MANIFEST}`,
      '{"lock":{"dependencies":{"__proto__":["verdict-format"]},"resolutions":{}}}',
    );
    expect([...(await readLock(root)).recordedSkills]).toStrictEqual([
      "__proto__",
    ]);
  });
});

test("a lock whose dependencies are not an object is refused", async () => {
  await expect(readWritten('{"lock":{"dependencies":123}}')).rejects.toThrow(
    ConfigError,
  );
});

test("every empty resolutions map is made without a prototype", async () => {
  // Stated directly because the two paths that produce one are reached before
  // anything has been recorded, which is exactly when a tree is being adopted.
  const absent = await withEmptyDir(async (root) => await readLock(root));
  expect(Object.getPrototypeOf(absent.resolutions)).toBeNull();

  const withoutKey = await readWritten('{"lock":{"dependencies":{}}}');
  expect(Object.getPrototypeOf(withoutKey)).toBeNull();
});
