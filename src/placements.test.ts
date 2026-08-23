import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { readLockFile, runCli, withGoodTree, writeFile } from "./testing.ts";

const RUNTIME = "tools/workflow-runtime";
const DEST = "skills/release-notes/scripts/_runtime";

/**
 * The clean fixture with one raw-byte contract added: a directory of scripts
 * at the conventional-looking `tools/` position, mapped by a table row into one
 * skill's `scripts/_runtime/`, and declared by that skill.
 */
async function withRawTree<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return await withGoodTree(async (root) => {
    await writeFile(`${root}/${RUNTIME}/runtime.py`, "print('run')\r\n");
    await writeFile(`${root}/${RUNTIME}/lib/helpers.py`, "HELP = 1\n");
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      "contracts:\n" +
        "  workflow-runtime:\n" +
        "    source: local\n" +
        "    files:\n" +
        "      tools/workflow-runtime/: scripts/_runtime/\n",
    );
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - changelog-entry\n",
        "    - changelog-entry\n    - workflow-runtime\n",
      ),
    );
    return await fn(root);
  });
}

test("gen places a directory contract at the skill's dest byte for byte and records the placement", async () => {
  await withRawTree(async (root) => {
    const result = await runCli(["gen", "--root", root]);
    expect(
      result.code,
      result.stdout.concat(result.stderr).join("\n"),
    ).toStrictEqual(0);

    // Raw bytes: the CRLF survives, unlike a document contract's body.
    expect(await fs.readFile(`${root}/${DEST}/runtime.py`, "utf8")).toBe(
      "print('run')\r\n",
    );
    expect(await fs.readFile(`${root}/${DEST}/lib/helpers.py`, "utf8")).toBe(
      "HELP = 1\n",
    );
    const lock = await readLockFile(root);
    expect(lock.resolutions["workflow-runtime"].kind).toBe("raw");
    const placement = lock.placements["release-notes"]["scripts/_runtime/"];
    expect(placement.contract).toBe("workflow-runtime");
    expect(placement.src).toBe("tools/workflow-runtime/");
    expect(placement.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.stdout).toContain(
      `adopted: workflow-runtime ${lock.resolutions["workflow-runtime"].digest} (initial adoption)`,
    );
  });
});
