import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { readRawMaterials } from "./rawsource.ts";
import { withEmptyDir, writeFile } from "./test-support/testing.ts";

test("distribution exclusions narrow directory mappings but not explicit file mappings", async () => {
  await withEmptyDir(async (root) => {
    await writeFile(`${root}/tools/runtime/keep.ts`, "keep");
    await writeFile(`${root}/tools/runtime/drop.tmp`, "drop");
    await writeFile(`${root}/tools/explicit.tmp`, "explicit");
    const materials = await readRawMaterials(
      root,
      "runtime",
      [
        { src: "tools/runtime", dest: "runtime", kind: "directory" },
        { src: "tools/explicit.tmp", dest: "explicit.tmp", kind: "file" },
      ],
      true,
      ["*.tmp"],
      [],
    );
    expect(
      Array.isArray(materials) && materials[0].files.map((f) => f.relative),
    ).toStrictEqual(["keep.ts"]);
    expect(Array.isArray(materials) && materials[1].files[0].content).toEqual(
      new TextEncoder().encode("explicit"),
    );
  });
});

test("unsafe files are refused before distribution exclusions are applied", async () => {
  await withEmptyDir(async (root) => {
    await writeFile(`${root}/tools/runtime/keep.ts`, "keep");
    await writeFile(`${root}/tools/runtime/.gitignore`, "*.tmp\n");
    await expect(
      readRawMaterials(
        root,
        "runtime",
        [{ src: "tools/runtime", dest: "runtime", kind: "directory" }],
        true,
        [".gitignore"],
        [],
      ),
    ).rejects.toThrow(ConfigError);
  });
});

test("an anchored exclusion is relative to each directory mapping", async () => {
  await withEmptyDir(async (root) => {
    for (const directory of ["one", "two"]) {
      await writeFile(`${root}/${directory}/generated.ts`, "generated");
      await writeFile(`${root}/${directory}/keep.ts`, "keep");
    }
    const materials = await readRawMaterials(
      root,
      "runtime",
      [
        { src: "one", dest: "one", kind: "directory" },
        { src: "two", dest: "two", kind: "directory" },
      ],
      true,
      ["/generated.ts"],
      [],
    );
    expect(
      Array.isArray(materials) &&
        materials.map((material) =>
          material.files.map((file) => file.relative),
        ),
    ).toStrictEqual([["keep.ts"], ["keep.ts"]]);
  });
});

test("a directory mapping emptied by distribution exclusions is a configuration error", async () => {
  await withEmptyDir(async (root) => {
    await writeFile(`${root}/tools/runtime/only.tmp`, "drop");
    await expect(
      readRawMaterials(
        root,
        "runtime",
        [{ src: "tools/runtime", dest: "runtime", kind: "directory" }],
        true,
        ["*.tmp"],
        [],
      ),
    ).rejects.toThrow(ConfigError);
  });
});
