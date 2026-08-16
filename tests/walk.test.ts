import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  atomicWriteFile,
  collectConformanceEntries,
  ConfigError,
  conformanceDigest,
  conformanceDigestOfEntries,
  decodeUtf8,
  walkFiles,
} from "../src/vendor.ts";
import {
  replaceWithSymlink,
  snapshotTree,
  withEmptyDir,
  withGoodTree,
  writeFile,
} from "./helpers.ts";

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

Deno.test("walking refuses a directory holding a symlinked file", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "secret.md");
    await replaceWithSymlink(
      `${root}/skills/release-notes/references/vendor/changelog-entry.md`,
      secret,
    );
    const error = await assertRejects(
      () => walkFiles(`${root}/skills`),
      ConfigError,
    );
    assertStringIncludes(error.message, "changelog-entry.md");
  });
});

Deno.test("walking refuses a symlink whose target does not exist", async () => {
  await withGoodTree(async (root) => {
    await replaceWithSymlink(
      `${root}/skills/release-notes/references/vendor/changelog-entry.md`,
      `${outsideOf(root)}/nothing-here.md`,
    );
    await assertRejects(() => walkFiles(`${root}/skills`), ConfigError);
  });
});

Deno.test("walking refuses a skill directory that is itself a symlink", async () => {
  await withGoodTree(async (root) => {
    const elsewhere = `${outsideOf(root)}/elsewhere`;
    await Deno.mkdir(elsewhere, { recursive: true });
    await replaceWithSymlink(`${root}/skills/release-notes`, elsewhere);
    await assertRejects(() => walkFiles(`${root}/skills`), ConfigError);
  });
});

Deno.test("a refused walk reads nothing through the symlink and changes nothing outside", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "secret.md");
    const outside = outsideOf(root);
    const before = await snapshotTree(outside);
    await replaceWithSymlink(
      `${root}/skills/review-writer/references/vendor/verdict-format.md`,
      secret,
    );
    await assertRejects(() => walkFiles(`${root}/skills`), ConfigError);
    assertEquals(await snapshotTree(outside), before);
  });
});

Deno.test("collecting conformance files refuses a symlink inside the tree", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "case.md");
    await replaceWithSymlink(
      `${root}/contracts/changelog-entry/conformance/cases/minimal.md`,
      secret,
    );
    await assertRejects(
      () =>
        collectConformanceEntries(
          `${root}/contracts/changelog-entry/conformance`,
        ),
      ConfigError,
    );
  });
});

Deno.test("an atomic write leaves no temporary file behind", async () => {
  await withEmptyDir(async (dir) => {
    await atomicWriteFile(`${dir}/out.md`, encoder.encode("written\n"));
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(names, ["out.md"]);
    assertEquals(await Deno.readTextFile(`${dir}/out.md`), "written\n");
  });
});

Deno.test("an atomic write replaces the previous content whole", async () => {
  await withEmptyDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/out.md`,
      "a much longer previous content\n",
    );
    await atomicWriteFile(`${dir}/out.md`, encoder.encode("short\n"));
    assertEquals(await Deno.readTextFile(`${dir}/out.md`), "short\n");
  });
});

Deno.test("a write whose target is a directory fails and names the path", async () => {
  await withEmptyDir(async (dir) => {
    await Deno.mkdir(`${dir}/out.md`);
    const error = await assertRejects(
      () => atomicWriteFile(`${dir}/out.md`, encoder.encode("written\n")),
      ConfigError,
    );
    assertStringIncludes(error.message, "out.md");
  });
});

Deno.test("a write refuses a symlink pre-planted at its temporary path", async () => {
  await withGoodTree(async (root) => {
    const secret = await plantOutsideFile(root, "manifest-target.json");
    const outside = outsideOf(root);
    const before = await snapshotTree(outside);
    const treeBefore = await snapshotTree(root);
    await replaceWithSymlink(`${root}/vendor-manifest.json.tmp`, secret);
    await assertRejects(
      () =>
        atomicWriteFile(
          `${root}/vendor-manifest.json`,
          encoder.encode("{}\n"),
        ),
      ConfigError,
    );
    assertEquals(await snapshotTree(outside), before);
    const treeAfter = await snapshotTree(root);
    treeAfter.delete("vendor-manifest.json.tmp");
    assertEquals(treeAfter, treeBefore);
  });
});

Deno.test("conformance framing matches its reference vector", async () => {
  // Framed by hand as 'path NUL size NUL bytes' and hashed with sha256sum.
  assertEquals(
    await conformanceDigestOfEntries([
      { path: "a/x.txt", content: encoder.encode("XY") },
      { path: "b.txt", content: encoder.encode("B\n") },
    ]),
    "sha256:7bfb47738b94157bbf9d0b7de2a62a9c775f5bd67891dadf284be77d2bddea2e",
  );
});

Deno.test("conformance framing orders files by relative posix path", async () => {
  assertEquals(
    await conformanceDigestOfEntries([
      { path: "b.txt", content: encoder.encode("B\n") },
      { path: "a/x.txt", content: encoder.encode("XY") },
    ]),
    "sha256:7bfb47738b94157bbf9d0b7de2a62a9c775f5bd67891dadf284be77d2bddea2e",
  );
});

Deno.test("conformance content is hashed as raw bytes, not canonicalized text", async () => {
  const lf = await conformanceDigestOfEntries([
    { path: "a.txt", content: encoder.encode("one\ntwo\n") },
  ]);
  const crlf = await conformanceDigestOfEntries([
    { path: "a.txt", content: encoder.encode("one\r\ntwo\r\n") },
  ]);
  assertEquals(lf === crlf, false);
});

Deno.test("bytecode caches are excluded from the conformance digest", async () => {
  await withGoodTree(async (root) => {
    const before = await conformanceDigest(root, "changelog-entry");
    await writeFile(
      `${root}/contracts/changelog-entry/conformance/cases/__pycache__/x.pyc`,
      "compiled bytes\n",
    );
    assertEquals(await conformanceDigest(root, "changelog-entry"), before);
  });
});

Deno.test("a conformance directory left empty by the exclusion counts as absent", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/verdict-format/conformance/__pycache__/x.pyc`,
      "compiled bytes\n",
    );
    assertEquals(await conformanceDigest(root, "verdict-format"), null);
  });
});

Deno.test("a contract with no conformance directory has no conformance digest", async () => {
  await withGoodTree(async (root) => {
    assertEquals(await conformanceDigest(root, "verdict-format"), null);
  });
});

Deno.test("content that is not valid UTF-8 is a configuration error naming the file", () => {
  const error = assertThrows(
    () => decodeUtf8(new Uint8Array([0x41, 0xff, 0xfe]), "contracts/broken.md"),
    ConfigError,
  );
  assertStringIncludes(error.message, "contracts/broken.md");
});
