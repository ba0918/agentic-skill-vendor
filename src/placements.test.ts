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
    await writeFile(`${root}/.gitignore`, "/.agentic-skill-vendor/\n");
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

/** Declares the runtime in a second skill too. */
async function alsoDeclareIn(root: string, skill: string): Promise<void> {
  const file = `${root}/skills/${skill}/SKILL.md`;
  await fs.writeFile(
    file,
    (await fs.readFile(file, "utf8")).replace(
      "  contracts:\n",
      "  contracts:\n    - workflow-runtime\n",
    ),
  );
}

async function undeclareIn(root: string, skill: string): Promise<void> {
  const file = `${root}/skills/${skill}/SKILL.md`;
  await fs.writeFile(
    file,
    (await fs.readFile(file, "utf8")).replace("    - workflow-runtime\n", ""),
  );
}

test("a skill that stops declaring a raw-byte contract has its dest swept and reported", async () => {
  await withRawTree(async (root) => {
    await alsoDeclareIn(root, "review-writer");
    await runCli(["gen", "--root", root]);
    await undeclareIn(root, "review-writer");

    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toContain(
      "cleared: skills/review-writer/scripts/_runtime/ (workflow-runtime)",
    );
    await expect(
      fs.stat(`${root}/skills/review-writer/scripts/_runtime`),
    ).rejects.toThrow();
    // The other skill's copy at the same dest string is untouched.
    expect(await fs.readFile(`${root}/${DEST}/runtime.py`, "utf8")).toBe(
      "print('run')\r\n",
    );
    expect((await readLockFile(root)).placements["review-writer"]).toBe(
      undefined,
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a dest renamed in the table is written anew and the old dest swept in one gen", async () => {
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
    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toContain(
      "cleared: skills/release-notes/scripts/_runtime/ (workflow-runtime)",
    );
    expect(result.stdout.filter((l) => l.startsWith("adopted:"))).toStrictEqual(
      [],
    );
    expect(
      await fs.readFile(
        `${root}/skills/release-notes/scripts/runtime/runtime.py`,
        "utf8",
      ),
    ).toBe("print('run')\r\n");
    await expect(fs.stat(`${root}/${DEST}`)).rejects.toThrow();
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a dest due to be swept that the user edited is refused before anything is written", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await undeclareIn(root, "release-notes");
    await fs.writeFile(`${root}/${DEST}/runtime.py`, "mine now\n");
    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain(DEST);
    expect(await fs.readFile(`${root}/${DEST}/runtime.py`, "utf8")).toBe(
      "mine now\n",
    );
  });
});

test("a sweep target that is already gone is reported as absent and forgotten", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await fs.rm(`${root}/skills/release-notes`, { recursive: true });
    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(0);
    expect(result.stdout).toContain(
      "cleared: skills/release-notes/scripts/_runtime/ (workflow-runtime; already absent)",
    );
    expect((await readLockFile(root)).placements).toBe(undefined);
  });
});

test("gen builds a dest outside the skill, so a neighbour named like a temporary is untouched", async () => {
  await withRawTree(async (root) => {
    // The user's own directory beside the dest, named as a sibling temporary
    // would be. Built in place, the run would clear it as "nobody's data".
    await writeFile(`${root}/${DEST}.tmp/keep.txt`, "mine\n");
    const result = await runCli(["gen", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(await fs.readFile(`${root}/${DEST}.tmp/keep.txt`, "utf8")).toBe(
      "mine\n",
    );
    await expect(
      fs.stat(`${root}/.agentic-skill-vendor/staging`),
    ).resolves.toBeDefined();
  });
});

test("gen warns when the tool directory its staging lives under is not ignored", async () => {
  await withRawTree(async (root) => {
    await fs.rm(`${root}/.gitignore`);
    const result = await runCli(["gen", "--root", root]);
    expect(result.stdout.join("\n")).toContain(
      "warning: .agentic-skill-vendor/staging is not ignored",
    );
    await fs.writeFile(`${root}/.gitignore`, "/.agentic-skill-vendor/\n");
    const quiet = await runCli(["gen", "--root", root]);
    expect(quiet.stdout.join("\n")).not.toContain("warning:");
  });
});

test("ignored files that appear inside a directory dest neither fail verify nor block gen", async () => {
  await withRawTree(async (root) => {
    await fs.appendFile(`${root}/.gitignore`, "__pycache__/\n");
    await runCli(["gen", "--root", root]);
    await writeFile(`${root}/${DEST}/__pycache__/runtime.pyc`, "\x00\x01");
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code, gen.stderr.join("\n")).toStrictEqual(0);
    await expect(
      fs.stat(`${root}/${DEST}/__pycache__/runtime.pyc`),
    ).rejects.toThrow();
  });
});

test("a dest the tree's ignore rules exclude is refused rather than written into the dark", async () => {
  await withRawTree(async (root) => {
    await fs.appendFile(`${root}/.gitignore`, "_runtime/\n");
    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code).toStrictEqual(2);
    expect(gen.stderr.join("\n")).toContain("_runtime");
    expect(gen.stderr.join("\n")).toContain(".gitignore");
  });
});

test("a distributed file that would be ignored at its dest is refused at planning", async () => {
  await withRawTree(async (root) => {
    await fs.appendFile(`${root}/skills/release-notes/.gitignore`, "*.py\n");
    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code).toStrictEqual(2);
    expect(gen.stderr.join("\n")).toContain("helpers.py");
    await expect(fs.stat(`${root}/${DEST}`)).rejects.toThrow();
  });
});

test("a .gitignore or a top-level .vendored inside a directory src is refused", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/${RUNTIME}/.gitignore`, "*.pyc\n");
    const one = await runCli(["gen", "--root", root]);
    expect(one.code).toStrictEqual(2);
    expect(one.stderr.join("\n")).toContain(`${RUNTIME}/.gitignore`);
    await fs.rm(`${root}/${RUNTIME}/.gitignore`);
    await writeFile(`${root}/${RUNTIME}/.vendored`, "x");
    const two = await runCli(["gen", "--root", root]);
    expect(two.code).toStrictEqual(2);
    expect(two.stderr.join("\n")).toContain(`${RUNTIME}/.vendored`);
  });
});
