import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  runCli,
  snapshotTree,
  withGoodTree,
  writeFile,
} from "../src/testing.ts";

const CONTRACT = "contracts/verdict-format.md";
const COPY = "skills/review-writer/references/vendor/verdict-format.md";
const MANIFEST = "vendor-manifest.json";
const CONFORMANCE = "contracts/changelog-entry/conformance/cases/minimal.md";

// deno-lint-ignore no-explicit-any
type Json = any;

async function readManifest(root: string): Promise<Json> {
  return JSON.parse(await Deno.readTextFile(`${root}/${MANIFEST}`));
}

async function writeManifest(root: string, manifest: Json): Promise<void> {
  await Deno.writeTextFile(
    `${root}/${MANIFEST}`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

async function append(path: string, text: string): Promise<void> {
  await Deno.writeTextFile(path, await Deno.readTextFile(path) + text);
}

async function forget(root: string, id: string): Promise<void> {
  const manifest = await readManifest(root);
  delete manifest.lock.resolutions[id];
  await writeManifest(root, manifest);
}

Deno.test("accepting a contract for the first time records its resolution", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    assertEquals((await runCli(["gen", "--root", root])).code, 1);

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    assertEquals(result.code, 0, result.stderr.join("\n"));
    assertStringIncludes(
      (await readManifest(root)).lock.resolutions["verdict-format"].digest,
      "sha256:",
    );
    assertEquals((await runCli(["verify", "--root", root])).code, 0);
  });
});

Deno.test("a first adoption is reported as having no previous digest", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    const result = await runCli(["accept", "verdict-format", "--root", root]);
    assertEquals(result.stdout[0], "accepted: verdict-format");
    assertEquals(result.stdout[1], "  old-digest: none (initial adoption)");
  });
});

Deno.test("accepting an updated contract reports the old digest, the new one and its dependents", async () => {
  await withGoodTree(async (root) => {
    const before =
      (await readManifest(root)).lock.resolutions["verdict-format"].digest;
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    assertEquals(result.code, 0, result.stderr.join("\n"));
    const after =
      (await readManifest(root)).lock.resolutions["verdict-format"].digest;
    assertEquals(result.stdout, [
      "accepted: verdict-format",
      `  old-digest: ${before}`,
      `  new-digest: ${after}`,
      "  dependents: review-writer",
    ]);
    assertEquals(after === before, false);
  });
});

Deno.test("a contract no skill declares is accepted with no dependents", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/orphan-contract.md`,
      "# Orphan\n\nDeclared by nobody yet.\n",
    );

    const result = await runCli(["accept", "orphan-contract", "--root", root]);
    assertEquals(result.code, 0, result.stderr.join("\n"));
    assertEquals(result.stdout[3], "  dependents: (none)");
    assertEquals((await runCli(["verify", "--root", root])).code, 0);
  });
});

Deno.test("accepting an updated contract leaves every SKILL.md untouched", async () => {
  await withGoodTree(async (root) => {
    const before = await snapshotTree(root);
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    assertEquals(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
      0,
    );
    const after = await snapshotTree(root);

    for (
      const path of [...before.keys()].filter((p) => p.endsWith("SKILL.md"))
    ) {
      assertEquals(after.get(path), before.get(path), path);
    }
    // What a contract update is allowed to move: the lock and the copies.
    assertEquals(after.get(MANIFEST) === before.get(MANIFEST), false);
    assertEquals(after.get(COPY) === before.get(COPY), false);
  });
});

Deno.test("accepting rewrites the vendored copies to the newly accepted text", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    assertEquals(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
      0,
    );
    assertStringIncludes(
      await Deno.readTextFile(`${root}/${COPY}`),
      "- One further rule.",
    );
    assertEquals((await runCli(["verify", "--root", root])).code, 0);
  });
});

Deno.test("accepting adopts the conformance tree alongside the text", async () => {
  await withGoodTree(async (root) => {
    const before =
      (await readManifest(root)).lock.resolutions["changelog-entry"]
        .conformance;
    await append(`${root}/${CONFORMANCE}`, "\nAnd one more expectation.\n");

    assertEquals(
      (await runCli(["accept", "changelog-entry", "--root", root])).code,
      0,
    );
    const after = (await readManifest(root)).lock.resolutions["changelog-entry"]
      .conformance;
    assertEquals(after === before, false);
    assertEquals((await runCli(["verify", "--root", root])).code, 0);
  });
});

Deno.test("accepting records the version written in the contract frontmatter", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    assertEquals(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
      0,
    );
    assertEquals(
      (await readManifest(root)).lock.resolutions["verdict-format"].version,
      "1.2.0",
    );
  });
});

Deno.test("accepting one contract leaves the resolution of another alone", async () => {
  await withGoodTree(async (root) => {
    const before =
      (await readManifest(root)).lock.resolutions["changelog-entry"];
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    assertEquals(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
      0,
    );
    assertEquals(
      (await readManifest(root)).lock.resolutions["changelog-entry"],
      before,
    );
  });
});

Deno.test("accepting several contracts in one run reports each of them", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    await forget(root, "changelog-entry");

    const result = await runCli([
      "accept",
      "verdict-format",
      "changelog-entry",
      "--root",
      root,
    ]);
    assertEquals(result.code, 0, result.stderr.join("\n"));
    assertEquals(
      result.stdout.filter((l) => l.startsWith("accepted: ")).length,
      2,
    );
    assertEquals((await runCli(["verify", "--root", root])).code, 0);
  });
});

Deno.test("accepting writes nothing while another declared contract stays unaccepted", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    await forget(root, "changelog-entry");
    const before = await snapshotTree(root);

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    assertEquals(result.code, 1);
    assertEquals(result.stdout.some((l) => l.startsWith("unresolved:")), true);
    assertEquals(await snapshotTree(root), before);
  });
});

Deno.test("accepting a contract with no canonical file is a usage error", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli(["accept", "no-such-contract", "--root", root]);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
    assertStringIncludes(result.stderr.join("\n"), "no-such-contract");
  });
});

Deno.test("accepting an unusable contract id is a usage error", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli(["accept", "../escape", "--root", root]);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
  });
});

Deno.test("accepting with no contract named is a usage error", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli(["accept", "--root", root]);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
  });
});
