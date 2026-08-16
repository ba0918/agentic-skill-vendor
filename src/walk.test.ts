import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ConfigError } from "./errors.ts";
import { atomicWriteFile, decodeUtf8, walkFiles } from "./walk.ts";
import {
  rejectedBy,
  replaceWithSymlink,
  snapshotTree,
  thrownBy,
  withEmptyDir,
  withGoodTree,
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
    await atomicWriteFile(`${dir}/out.md`, encoder.encode("written\n"));
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
    await atomicWriteFile(`${dir}/out.md`, encoder.encode("short\n"));
    expect(await fs.readFile(`${dir}/out.md`, "utf8")).toStrictEqual("short\n");
  });
});

test("a write whose target is a directory fails and names the path", async () => {
  await withEmptyDir(async (dir) => {
    await fs.mkdir(`${dir}/out.md`);
    const error = await rejectedBy(
      () => atomicWriteFile(`${dir}/out.md`, encoder.encode("written\n")),
      ConfigError,
    );
    expect(error.message).toContain("out.md");
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
      atomicWriteFile(`${root}/vendor-manifest.json`, encoder.encode("{}\n")),
    ).rejects.toThrow(ConfigError);
    expect(await snapshotTree(outside)).toStrictEqual(before);
    const treeAfter = await snapshotTree(root);
    treeAfter.delete("vendor-manifest.json.tmp");
    expect(treeAfter).toStrictEqual(treeBefore);
  });
});

test("content that is not valid UTF-8 is a configuration error naming the file", () => {
  const error = thrownBy(
    () => decodeUtf8(new Uint8Array([0x41, 0xff, 0xfe]), "contracts/broken.md"),
    ConfigError,
  );
  expect(error.message).toContain("contracts/broken.md");
});
