import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError } from "./errors.ts";
import { canonicalJson, readLock, type Resolutions } from "./manifest.ts";
import {
  readManifest,
  runCli,
  snapshotTree,
  withEmptyDir,
  withGoodTree,
} from "./testing.ts";

const MANIFEST = "vendor-manifest.json";

test("the manifest keeps dependencies and resolutions apart", async () => {
  await withGoodTree(async (root) => {
    const lock = await readManifest(root);
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
    const resolutions = (await readManifest(root)).resolutions;
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

test("a withdrawn contract's resolution is pruned when gen rewrites the lock", async () => {
  await withGoodTree(async (root) => {
    // changelog-entry ships conformance tests, so a full withdrawal — no skill
    // declaring it, its canonical file gone — leaves a resolution whose
    // conformance check no run can ever satisfy. Left in the lock, verify
    // fails on it forever and no run can record a new value for it (the text
    // is not there); gen must prune the resolution whose canonical file is
    // gone.
    for (const name of ["release-notes", "review-writer"]) {
      await fs.writeFile(
        `${root}/skills/${name}/SKILL.md`,
        `---\nname: ${name}\n---\n\n# ${name}\n`,
      );
    }
    await fs.rm(`${root}/contracts/changelog-entry.md`);
    await fs.rm(`${root}/contracts/changelog-entry`, { recursive: true });

    const verifyBefore = await runCli(["verify", "--root", root]);
    expect(verifyBefore.code).toStrictEqual(1);
    expect(verifyBefore.stdout.join("\n")).toContain("conformance-mismatch");

    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code, gen.stdout.concat(gen.stderr).join("\n")).toStrictEqual(0);
    // The retirement is reported, not done silently: gen's output names the
    // resolution it removed along with the copy removal.
    expect(gen.stdout.join("\n")).toContain("retired: changelog-entry");
    expect(
      "changelog-entry" in (await readManifest(root)).resolutions,
    ).toStrictEqual(false);
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("the lock records only the contracts whose canonical text is present", async () => {
  await withGoodTree(async (root) => {
    // The contract is withdrawn: no skill declares it any more and the
    // canonical file is gone. gen prunes the resolution recorded for it, so
    // the lock stops naming text the tree does not hold.
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
    const resolutions = (await readManifest(root)).resolutions;
    expect("verdict-format" in resolutions).toStrictEqual(false);
    expect(resolutions["changelog-entry"].digest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a tree whose skills declare nothing still refuses a contracts directory symlinked outside", async () => {
  await withGoodTree(async (root) => {
    // Every skill is stripped of its declarations, so the lock is the only
    // thing still naming a contract. A run reads the contracts the lock records
    // as well as the ones a declaration names, and both routes have to refuse
    // the link: read through it, the run would digest text from outside the
    // tree and record it as what the tree holds.
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
    // The planted link itself is what the refusal names. Naming a file below it
    // instead would describe a path that only exists because the link was
    // followed, and no contract is reached before the directory holding them
    // all is checked.
    expect(result.stderr.join("\n")).toStrictEqual(
      "error: symlink is not allowed inside the tree: contracts",
    );
  });
});

test("rendering the manifest refuses a contract's own directory symlinked outside the tree", async () => {
  await withGoodTree(async (root) => {
    // The contract that no skill declares any more: reading the canonical text
    // never reaches it, so the lock is the one thing still naming it and the
    // manifest render is the only route left to contracts/. Refused for the same
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

    for (const command of [["gen"], ["verify"]]) {
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
  return `{"dependencies":{},"resolutions":${resolutions}}`;
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
        `{"verdict-format":{"conformance":"${DIGEST}","digest":"${DIGEST}"}}`,
      ),
    ),
  ).toStrictEqual({
    "verdict-format": { digest: DIGEST, conformance: DIGEST },
  });
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

test("a manifest that is not an object is refused", async () => {
  await expect(readWritten(`"oops"`)).rejects.toThrow(ConfigError);
  await expect(readWritten(`[]`)).rejects.toThrow(ConfigError);
});

test("a manifest missing its dependencies is refused, not read as empty", async () => {
  // A hand-corrupted manifest that dropped a half would otherwise be read as
  // "no skills recorded", and the next gen would silently rewrite over it —
  // forgetting every skill the tree records a dependency list for. The one
  // empty lock is the whole file being absent, which is answered before JSON
  // is ever read.
  await expect(readWritten(`{}`)).rejects.toThrow(ConfigError);
  await expect(readWritten(`{"resolutions":{}}`)).rejects.toThrow(ConfigError);
});

test("a manifest whose dependencies are null is refused, not read as empty", async () => {
  await expect(
    readWritten(`{"dependencies":null,"resolutions":{}}`),
  ).rejects.toThrow(ConfigError);
});

test("a manifest missing its resolutions is refused, not read as empty", async () => {
  // The other half of the same corruption: a manifest that dropped its
  // resolutions, read as "nothing resolved yet", would let the next gen
  // rewrite the file with the memory of every recorded contract dropped.
  await expect(readWritten(`{"dependencies":{}}`)).rejects.toThrow(ConfigError);
});

test("a manifest whose resolutions are null is refused, not read as empty", async () => {
  await expect(
    readWritten(`{"dependencies":{},"resolutions":null}`),
  ).rejects.toThrow(ConfigError);
});

test("a resolution that is not an object is refused", async () => {
  await expect(
    readWritten(manifestWith(`{"verdict-format":"oops"}`)),
  ).rejects.toThrow(ConfigError);
});

test("a resolution whose conformance digest is not a sha256 digest is refused", async () => {
  await expect(
    readWritten(
      manifestWith(
        `{"verdict-format":{"conformance":"notadigest","digest":"${DIGEST}"}}`,
      ),
    ),
  ).rejects.toThrow(ConfigError);
});

test("resolutions written as a list are refused", async () => {
  await expect(readWritten(manifestWith(`["verdict-format"]`))).rejects.toThrow(
    ConfigError,
  );
});

test("a manifest that is not readable JSON is refused", async () => {
  await expect(readWritten(`{"dependencies":{`)).rejects.toThrow(ConfigError);
});

test("rendering the manifest refuses a contract file that is there but is not a regular file", async () => {
  await withGoodTree(async (root) => {
    // The contract no skill declares any more: reading canonical text never
    // reaches it, so the manifest render is the only route left to it. A
    // directory standing where its text belongs answered exactly as text that
    // is not there does, and the contract dropped out of the lock without a
    // word — gen finished at 0 and verify called the result clean.
    for (const name of ["release-notes", "review-writer"]) {
      await fs.writeFile(
        `${root}/skills/${name}/SKILL.md`,
        `---\nname: ${name}\n---\n\n# ${name}\n`,
      );
    }
    await fs.rm(`${root}/contracts/verdict-format.md`);
    await fs.mkdir(`${root}/contracts/verdict-format.md`);
    const before = await snapshotTree(root);

    for (const command of [["gen"], ["verify"]]) {
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

    for (const command of [["gen"], ["verify"]]) {
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
  const parsed = JSON.parse('{"dependencies":{"__proto__":["a"],"z":["b"]}}');
  const rendered = canonicalJson(parsed);
  expect(rendered).toContain('"__proto__"');
  expect(
    Object.getOwnPropertyDescriptor(
      JSON.parse(rendered).dependencies,
      "__proto__",
    )?.value,
  ).toStrictEqual(["a"]);
});

test("a manifest recording a skill named for a prototype key reads it back", async () => {
  await withEmptyDir(async (root) => {
    await fs.writeFile(
      `${root}/${MANIFEST}`,
      '{"dependencies":{"__proto__":["verdict-format"]},"resolutions":{}}',
    );
    expect([...(await readLock(root)).recordedSkills]).toStrictEqual([
      "__proto__",
    ]);
  });
});

test("a manifest whose dependencies are not an object is refused", async () => {
  await expect(readWritten('{"dependencies":123}')).rejects.toThrow(
    ConfigError,
  );
});

test("every empty resolutions map is made without a prototype", async () => {
  // Stated directly because the two paths that produce one — no manifest yet,
  // and a lock recording an empty map — are reached before anything has been
  // resolved, which is exactly when a tree is being adopted.
  const absent = await withEmptyDir(async (root) => await readLock(root));
  expect(Object.getPrototypeOf(absent.resolutions)).toBeNull();

  const recordedEmpty = await readWritten(manifestWith("{}"));
  expect(Object.getPrototypeOf(recordedEmpty)).toBeNull();
});

test("the manifest records nothing but the dependencies and the resolutions", async () => {
  await withGoodTree(async (root) => {
    expect(Object.keys(await readManifest(root)).sort()).toStrictEqual([
      "dependencies",
      "resolutions",
    ]);
  });
});

test("the manifest records no version for a resolved contract", async () => {
  await withGoodTree(async (root) => {
    const resolutions = (await readManifest(root)).resolutions;
    expect("version" in resolutions["verdict-format"]).toStrictEqual(false);
    expect("version" in resolutions["changelog-entry"]).toStrictEqual(false);
  });
});

test("a manifest written in the superseded wrapped form is refused", async () => {
  await expect(
    readWritten(`{"lock":{"dependencies":{},"resolutions":{}}}`),
  ).rejects.toThrow(ConfigError);
});
