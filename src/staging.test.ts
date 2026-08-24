import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { placeViaStaging, prepareStaging, STAGING_DIR } from "./staging.ts";
import { withEmptyDir } from "./testing.ts";

test("a cross-filesystem staging refusal leaves the existing dest untouched", async () => {
  await withEmptyDir(async (root) => {
    const relative = "skills/example/scripts/payload.txt";
    await fs.mkdir(`${root}/skills/example/scripts`, { recursive: true });
    await fs.writeFile(`${root}/${relative}`, "before\n");
    await prepareStaging(root);

    await expect(
      placeViaStaging(
        root,
        relative,
        { content: new TextEncoder().encode("after\n") },
        async (path) => (path.includes(`/${STAGING_DIR}/`) ? 1 : 2),
      ),
    ).rejects.toThrow("different file systems");

    expect(await fs.readFile(`${root}/${relative}`, "utf8")).toStrictEqual(
      "before\n",
    );
    expect(await fs.readdir(`${root}/${STAGING_DIR}`)).toStrictEqual([]);
  });
});
