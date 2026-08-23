import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  readLockFile,
  runCli,
  withGoodTree,
  writeFile,
  writeLockFile,
} from "./testing.ts";

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

test("verify accepts the tree gen has just placed a raw-byte contract into", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const result = await runCli(["verify", "--root", root]);
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("gen over an unchanged raw-byte contract replaces its own dest and reports nothing", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const before = await readLockFile(root);
    const result = await runCli(["gen", "--root", root]);
    expect(
      result.code,
      result.stdout.concat(result.stderr).join("\n"),
    ).toStrictEqual(0);
    expect(result.stdout).toStrictEqual([]);
    expect(await readLockFile(root)).toStrictEqual(before);
  });
});

test("a hand-edited file inside a directory dest is reported as drift and refused by gen", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await fs.writeFile(`${root}/${DEST}/runtime.py`, "print('edited')\n");

    const verify = await runCli(["verify", "--root", root]);
    expect(verify.code).toStrictEqual(1);
    expect(verify.stdout.join("\n")).toContain(`drift: ${DEST}`);

    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code).toStrictEqual(2);
    expect(gen.stderr.join("\n")).toContain(`refusing to write ${DEST}`);
  });
});

test("a deleted marker is reported as drift", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await fs.rm(`${root}/${DEST}/.vendored`);
    const result = await runCli(["verify", "--root", root]);
    expect(result.stdout.join("\n")).toContain(`drift: ${DEST}/.vendored`);
  });
});

test("a dest renamed in the table without gen is reported as a placement mismatch, not drift", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8")).replace(
        "scripts/_runtime/",
        "scripts/runtime/",
      ),
    );
    const result = await runCli(["verify", "--root", root]);
    expect(result.code).toStrictEqual(1);
    expect(result.stdout.filter((l) => l.startsWith("drift:"))).toStrictEqual(
      [],
    );
    expect(result.stdout.join("\n")).toContain(
      "placement: skills/release-notes/scripts/runtime/ is declared",
    );
    expect(result.stdout.join("\n")).toContain(
      "placement: vendor-lock.json records skills/release-notes/scripts/_runtime/",
    );
  });
});

test("a lock whose placement digest was hand-edited passes the shape check and shows as drift", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const lock = await readLockFile(root);
    lock.placements["release-notes"]["scripts/_runtime/"].digest =
      `sha256:${"0".repeat(64)}`;
    await writeLockFile(root, lock);
    const result = await runCli(["verify", "--root", root]);
    expect(result.stdout.join("\n")).toContain(`drift: ${DEST} holds files`);
  });
});
