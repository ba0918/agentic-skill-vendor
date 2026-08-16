import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import { readResolutions, type Resolutions } from "./manifest.ts";
import { runCli, withEmptyDir, withGoodTree } from "./testing.ts";

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
    expect(provenance.generator.name).toStrictEqual("vendor.ts");
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
