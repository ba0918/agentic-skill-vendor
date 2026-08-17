import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import { readResolutions, type Resolutions } from "./manifest.ts";
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
    return await readResolutions(root);
  });
}

function manifestWith(resolutions: string): string {
  return `{"lock":{"resolutions":${resolutions}}}`;
}

const DIGEST = `sha256:${"0".repeat(64)}`;

test("a tree with no manifest has no resolutions", async () => {
  expect(await withEmptyDir((root) => readResolutions(root))).toStrictEqual({});
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
