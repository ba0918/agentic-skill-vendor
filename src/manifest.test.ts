import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ConfigError } from "./errors.ts";
import { readResolutions, type Resolutions } from "./manifest.ts";
import { runCli, withEmptyDir, withGoodTree } from "./testing.ts";

const MANIFEST = "vendor-manifest.json";

// deno-lint-ignore no-explicit-any
type Json = any;

async function readManifest(root: string): Promise<Json> {
  return JSON.parse(await Deno.readTextFile(`${root}/${MANIFEST}`));
}

Deno.test("the manifest keeps dependencies and resolutions apart", async () => {
  await withGoodTree(async (root) => {
    const lock = (await readManifest(root)).lock;
    assertEquals(lock.dependencies["review-writer"], [
      "changelog-entry",
      "verdict-format",
    ]);
    assertEquals(lock.dependencies["release-notes"], ["changelog-entry"]);
    assertMatch(
      lock.resolutions["verdict-format"].digest,
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});

Deno.test("the manifest locks a conformance digest only for a contract shipping tests", async () => {
  await withGoodTree(async (root) => {
    const resolutions = (await readManifest(root)).lock.resolutions;
    assertMatch(
      resolutions["changelog-entry"].conformance,
      /^sha256:[0-9a-f]{64}$/,
    );
    assertEquals("conformance" in resolutions["verdict-format"], false);
  });
});

Deno.test("the manifest records no wall-clock timestamp", async () => {
  await withGoodTree(async (root) => {
    const text = await Deno.readTextFile(`${root}/${MANIFEST}`);
    assertEquals(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false);
  });
});

Deno.test("the manifest names where the tool and each contract came from", async () => {
  await withGoodTree(async (root) => {
    const provenance = (await readManifest(root)).provenance;
    assertEquals(provenance.generator.name, "vendor.ts");
    assertStringIncludes(provenance.generator.source, "github.com");
    assertEquals(
      provenance.contracts["verdict-format"].source,
      "contracts/verdict-format.md",
    );
  });
});

Deno.test("provenance names only the contracts whose canonical text is present", async () => {
  await withGoodTree(async (root) => {
    // The contract is withdrawn: no skill declares it any more and the
    // canonical file is gone. The resolution it was accepted under stays in the
    // lock, because accept is the only thing that writes resolutions.
    const skill = `${root}/skills/review-writer/SKILL.md`;
    await Deno.writeTextFile(
      skill,
      (await Deno.readTextFile(skill)).replace("    - verdict-format\n", ""),
    );
    await Deno.remove(`${root}/contracts/verdict-format.md`);

    const result = await runCli(["gen", "--root", root]);
    assertEquals(
      result.code,
      0,
      result.stdout.concat(result.stderr).join("\n"),
    );
    const provenance = (await readManifest(root)).provenance;
    assertEquals("verdict-format" in provenance.contracts, false);
    assertEquals(
      provenance.contracts["changelog-entry"].source,
      "contracts/changelog-entry.md",
    );
    assertEquals((await runCli(["verify", "--root", root])).code, 0);
  });
});

// The lock is read back from a file anyone can edit, and a resolution key
// becomes a path under contracts/. These state what the reader refuses.

/** Writes `manifest` as the tree's manifest and reads the resolutions back. */
async function readWritten(manifest: string): Promise<Resolutions> {
  return await withEmptyDir(async (root) => {
    await Deno.writeTextFile(`${root}/${MANIFEST}`, manifest);
    return await readResolutions(root);
  });
}

function manifestWith(resolutions: string): string {
  return `{"lock":{"resolutions":${resolutions}}}`;
}

const DIGEST = `sha256:${"0".repeat(64)}`;

Deno.test("a tree with no manifest has no resolutions", async () => {
  assertEquals(await withEmptyDir((root) => readResolutions(root)), {});
});

Deno.test("a recorded resolution is read back whole", async () => {
  assertEquals(
    await readWritten(
      manifestWith(
        `{"verdict-format":{"digest":"${DIGEST}","version":"1.2.0"}}`,
      ),
    ),
    { "verdict-format": { digest: DIGEST, version: "1.2.0" } },
  );
});

Deno.test("a resolution key that would escape the contracts directory is refused", async () => {
  await assertRejects(
    () =>
      readWritten(manifestWith(`{"../../etc/passwd":{"digest":"${DIGEST}"}}`)),
    ConfigError,
  );
});

Deno.test("a resolution whose digest is not a sha256 digest is refused", async () => {
  await assertRejects(
    () =>
      readWritten(manifestWith(`{"verdict-format":{"digest":"notadigest"}}`)),
    ConfigError,
  );
});

Deno.test("a resolution whose version is not text is refused", async () => {
  await assertRejects(
    () =>
      readWritten(
        manifestWith(`{"verdict-format":{"digest":"${DIGEST}","version":1}}`),
      ),
    ConfigError,
  );
});

Deno.test("a lock that is not an object is refused", async () => {
  await assertRejects(() => readWritten(`{"lock":"oops"}`), ConfigError);
});

Deno.test("resolutions written as a list are refused", async () => {
  await assertRejects(
    () => readWritten(manifestWith(`["verdict-format"]`)),
    ConfigError,
  );
});

Deno.test("a manifest that is not readable JSON is refused", async () => {
  await assertRejects(() => readWritten(`{"lock":{`), ConfigError);
});
