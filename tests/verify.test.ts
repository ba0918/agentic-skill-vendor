import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  replaceWithSymlink,
  runCli,
  withGoodTree,
  writeFile,
} from "./helpers.ts";

const COPY = "skills/review-writer/references/vendor/verdict-format.md";
const CONTRACT = "contracts/verdict-format.md";
const MANIFEST = "vendor-manifest.json";
const CONFORMANCE = "contracts/changelog-entry/conformance/cases/minimal.md";

function kindsOf(lines: string[]): string[] {
  return lines.map((line) => line.slice(0, line.indexOf(":"))).sort();
}

async function verify(root: string) {
  return await runCli(["verify", "--root", root]);
}

async function append(path: string, text: string): Promise<void> {
  await Deno.writeTextFile(path, await Deno.readTextFile(path) + text);
}

Deno.test("a freshly generated tree verifies clean", async () => {
  await withGoodTree(async (root) => {
    const result = await verify(root);
    assertEquals(result.stdout, []);
    assertEquals(result.code, 0);
  });
});

Deno.test("a hand-edited vendored copy is reported as drift", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${COPY}`, "\nEdited by hand after generation.\n");
    const result = await verify(root);
    assertEquals(result.code, 1);
    assertEquals(kindsOf(result.stdout), ["drift"]);
    assertStringIncludes(result.stdout[0], COPY);
  });
});

Deno.test("a missing vendored copy is reported as drift", async () => {
  await withGoodTree(async (root) => {
    await Deno.remove(`${root}/${COPY}`);
    assertEquals(kindsOf((await verify(root)).stdout), ["drift"]);
  });
});

Deno.test("a vendored copy whose header was rewritten is reported as drift", async () => {
  await withGoodTree(async (root) => {
    const text = await Deno.readTextFile(`${root}/${COPY}`);
    await Deno.writeTextFile(
      `${root}/${COPY}`,
      text.replace(
        "<!-- contract: verdict-format -->",
        "<!-- contract: other -->",
      ),
    );
    assertEquals(kindsOf((await verify(root)).stdout), ["drift"]);
  });
});

Deno.test("a vendored copy that is not valid UTF-8 is drift, not a configuration error", async () => {
  await withGoodTree(async (root) => {
    await Deno.writeFile(`${root}/${COPY}`, new Uint8Array([0xff, 0xfe, 0x00]));
    const result = await verify(root);
    assertEquals(result.code, 1);
    assertEquals(kindsOf(result.stdout), ["drift"]);
  });
});

Deno.test("a vendored file no declaration accounts for is reported as extra", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/skills/release-notes/references/vendor/orphan.md`,
      "left behind\n",
    );
    assertEquals(kindsOf((await verify(root)).stdout), ["extra"]);
  });
});

Deno.test("a subdirectory inside a vendor directory is reported as extra", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/skills/release-notes/references/vendor/nested/thing.md`,
      "nested\n",
    );
    assertEquals(kindsOf((await verify(root)).stdout), ["extra"]);
  });
});

Deno.test("a vendored copy under a directory holding no SKILL.md is reported as extra", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/skills/note-taker/references/vendor/changelog-entry.md`,
      "not declared by anything\n",
    );
    assertEquals(kindsOf((await verify(root)).stdout), ["extra"]);
  });
});

Deno.test("a declared contract with no canonical file is reported as a closure gap", async () => {
  await withGoodTree(async (root) => {
    await Deno.remove(`${root}/${CONTRACT}`);
    const kinds = kindsOf((await verify(root)).stdout);
    assertEquals(kinds.includes("closure"), true, kinds.join(","));
  });
});

Deno.test("canonical text ahead of the pin is unaccepted drift, and the copies still verify", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    const result = await verify(root);
    assertEquals(result.code, 1);
    // The copies still match what was accepted, so only the unapproved change
    // of the canonical text is reported. This is the state CI has to detect.
    assertEquals(kindsOf(result.stdout), ["unaccepted-drift"]);
  });
});

Deno.test("a copy edited while the canonical text also moved is reported on both counts", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    await append(`${root}/${COPY}`, "\nAlso edited by hand.\n");
    assertEquals(kindsOf((await verify(root)).stdout), [
      "drift",
      "unaccepted-drift",
    ]);
  });
});

Deno.test("a contract with no resolution is reported as unresolved", async () => {
  await withGoodTree(async (root) => {
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/${MANIFEST}`));
    delete manifest.lock.resolutions["verdict-format"];
    await Deno.writeTextFile(
      `${root}/${MANIFEST}`,
      JSON.stringify(manifest, null, 2) + "\n",
    );
    const kinds = kindsOf((await verify(root)).stdout);
    assertEquals(kinds.includes("unresolved"), true, kinds.join(","));
  });
});

Deno.test("a hand-edited manifest is reported as a manifest mismatch", async () => {
  await withGoodTree(async (root) => {
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/${MANIFEST}`));
    manifest.provenance.generator.version = "9.9.9";
    await Deno.writeTextFile(
      `${root}/${MANIFEST}`,
      JSON.stringify(manifest, null, 2) + "\n",
    );
    assertEquals(kindsOf((await verify(root)).stdout), ["manifest"]);
  });
});

Deno.test("a missing manifest is reported rather than treated as an empty tree", async () => {
  await withGoodTree(async (root) => {
    await Deno.remove(`${root}/${MANIFEST}`);
    const kinds = kindsOf((await verify(root)).stdout);
    assertEquals(kinds.includes("manifest"), true, kinds.join(","));
    assertEquals(kinds.includes("unresolved"), true, kinds.join(","));
  });
});

Deno.test("a declaration added without regenerating is reported as a manifest mismatch", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await Deno.writeTextFile(
      skill,
      (await Deno.readTextFile(skill)).replace(
        "    - changelog-entry\n",
        "    - changelog-entry\n    - verdict-format\n",
      ),
    );
    const kinds = kindsOf((await verify(root)).stdout);
    assertEquals(kinds.includes("manifest"), true, kinds.join(","));
    assertEquals(kinds.includes("drift"), true, kinds.join(","));
  });
});

Deno.test("an edited conformance test is reported as a conformance mismatch", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONFORMANCE}`, "\nAn extra expectation.\n");
    const result = await verify(root);
    assertEquals(result.code, 1);
    // Reported once. The locked value stays in the manifest comparison, so the
    // same divergence is not counted a second time as a stale manifest.
    assertEquals(kindsOf(result.stdout), ["conformance-mismatch"]);
  });
});

Deno.test("an added conformance file is reported as a conformance mismatch", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/changelog-entry/conformance/cases/second.md`,
      "another case\n",
    );
    assertEquals(kindsOf((await verify(root)).stdout), [
      "conformance-mismatch",
    ]);
  });
});

Deno.test("removing the whole conformance directory is reported as a conformance mismatch", async () => {
  await withGoodTree(async (root) => {
    await Deno.remove(`${root}/contracts/changelog-entry`, { recursive: true });
    assertEquals(kindsOf((await verify(root)).stdout), [
      "conformance-mismatch",
    ]);
  });
});

Deno.test("a contract gaining conformance tests nobody accepted is reported", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/verdict-format/conformance/cases/first.md`,
      "a new case\n",
    );
    assertEquals(kindsOf((await verify(root)).stdout), [
      "conformance-mismatch",
    ]);
  });
});

Deno.test("a conformance directory holding only bytecode still counts as absent", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/verdict-format/conformance/__pycache__/x.pyc`,
      "compiled\n",
    );
    assertEquals((await verify(root)).code, 0);
  });
});

Deno.test("verify reports the state a run interrupted part way through leaves", async () => {
  await withGoodTree(async (root) => {
    // A directory where a copy belongs stops the run once it has already
    // replaced the copies ordered before it.
    const blocked = "skills/review-writer/references/vendor/changelog-entry.md";
    await Deno.remove(`${root}/${COPY}`);
    await Deno.remove(`${root}/${blocked}`);
    await Deno.mkdir(`${root}/${blocked}`);

    assertEquals((await runCli(["gen", "--root", root])).code, 2);
    assertEquals((await verify(root)).code, 1);
  });
});

Deno.test("verify refuses a vendor directory symlinked outside the tree", async () => {
  await withGoodTree(async (root) => {
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await Deno.mkdir(outside, { recursive: true });
    await replaceWithSymlink(
      `${root}/skills/release-notes/references/vendor`,
      outside,
    );
    const result = await verify(root);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
  });
});

Deno.test("a SKILL.md with unclosed frontmatter makes verify exit 2", async () => {
  await withGoodTree(async (root) => {
    await Deno.writeTextFile(
      `${root}/skills/release-notes/SKILL.md`,
      "---\nname: release-notes\n\n# Release Notes\n",
    );
    const result = await verify(root);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
    assertStringIncludes(result.stderr.join("\n"), "error:");
  });
});

Deno.test("a contract that is not valid UTF-8 makes verify exit 2", async () => {
  await withGoodTree(async (root) => {
    await Deno.writeFile(
      `${root}/${CONTRACT}`,
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    const result = await verify(root);
    assertEquals(result.code, 2);
    assertEquals(result.stdout, []);
  });
});
