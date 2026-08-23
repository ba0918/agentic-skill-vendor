import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  fakeGitHub,
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

test("a dest the tree's ignore rules exclude is refused by gen and verify alike", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await fs.appendFile(`${root}/.gitignore`, "_runtime/\n");
    for (const command of ["gen", "verify"]) {
      const result = await runCli([command, "--root", root]);
      expect(result.code, command).toStrictEqual(2);
      expect(result.stderr.join("\n")).toContain("_runtime");
      expect(result.stderr.join("\n")).toContain(".gitignore");
    }
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

test("a file mapping lands one file at its dest and is checked by its own name", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/tools/scripts/run.py`, "RUN\n");
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "  helper-scripts:\n    source: local\n    files:\n      tools/scripts/run.py: scripts/run.py\n",
    );
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - workflow-runtime\n",
        "    - workflow-runtime\n    - helper-scripts\n",
      ),
    );
    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code, gen.stderr.join("\n")).toStrictEqual(0);
    expect(
      await fs.readFile(`${root}/skills/release-notes/scripts/run.py`, "utf8"),
    ).toBe("RUN\n");
    const lock = await readLockFile(root);
    expect(lock.placements["release-notes"]["scripts/run.py"].src).toBe(
      "tools/scripts/run.py",
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("the scribe leaves a files row alone when nothing declares it, and a person's deletion retires it", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await undeclareIn(root, "release-notes");
    const swept = await runCli(["gen", "--root", root]);
    expect(swept.code, swept.stderr.join("\n")).toStrictEqual(0);
    expect(swept.stdout.filter((l) => l.startsWith("unmapped:"))).toStrictEqual(
      [],
    );
    expect(await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8")).toContain(
      "workflow-runtime:",
    );
    expect(
      (await readLockFile(root)).resolutions["workflow-runtime"],
    ).toBeDefined();
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);

    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8")).replace(
        / {2}workflow-runtime:\n( {4}.*\n)*/,
        "",
      ),
    );
    const retired = await runCli(["gen", "--root", root]);
    expect(retired.stdout.join("\n")).toContain("retired: workflow-runtime");
    expect((await readLockFile(root)).resolutions["workflow-runtime"]).toBe(
      undefined,
    );
  });
});

test("a row rewritten from raw-byte to document, or back, is refused while the lock remembers the other kind", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const table = `${root}/vendor-manifest.yaml`;
    const raw = await fs.readFile(table, "utf8");
    await fs.writeFile(
      table,
      raw.replace(
        "    files:\n      tools/workflow-runtime/: scripts/_runtime/\n",
        "",
      ),
    );
    await writeFile(`${root}/contracts/workflow-runtime.md`, "# doc\n");
    const toDocument = await runCli(["gen", "--root", root]);
    expect(toDocument.code).toStrictEqual(2);
    expect(toDocument.stderr.join("\n")).toContain("workflow-runtime");
    expect(toDocument.stderr.join("\n")).toContain("raw");
  });
  await withGoodTree(async (root) => {
    await writeFile(`${root}/tools/x/a.txt`, "a\n");
    await writeFile(
      `${root}/vendor-manifest.yaml`,
      "contracts:\n  verdict-format:\n    source: local\n    files:\n      tools/x/: scripts/x/\n",
    );
    const toRaw = await runCli(["gen", "--root", root]);
    expect(toRaw.code).toStrictEqual(2);
    expect(toRaw.stderr.join("\n")).toContain("verdict-format");
  });
});

test("a raw-byte src edited without gen is a stale lock, and a declared one the lock forgot is unresolved", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await fs.appendFile(`${root}/${RUNTIME}/runtime.py`, "# more\n");
    const stale = await runCli(["verify", "--root", root]);
    expect(stale.code).toStrictEqual(1);
    expect(stale.stdout.join("\n")).toContain("stale-lock: workflow-runtime");

    await runCli(["gen", "--root", root]);
    const lock = await readLockFile(root);
    delete lock.resolutions["workflow-runtime"];
    await writeLockFile(root, lock);
    const unresolved = await runCli(["verify", "--root", root]);
    expect(unresolved.stdout.join("\n")).toContain(
      "unresolved: workflow-runtime",
    );
  });
});

test("two dests that nest, or a dest over the vendor directory, are refused by the table", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/tools/other/b.txt`, "b\n");
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "  other:\n    source: local\n    files:\n      tools/other/: scripts/_runtime/lib/\n",
    );
    const nested = await runCli(["gen", "--root", root]);
    expect(nested.code).toStrictEqual(2);
    expect(nested.stderr.join("\n")).toContain("scripts/_runtime/lib");
  });
  await withRawTree(async (root) => {
    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8")).replace(
        "scripts/_runtime/",
        "references/",
      ),
    );
    const over = await runCli(["gen", "--root", root]);
    expect(over.code).toStrictEqual(2);
    expect(over.stderr.join("\n")).toContain("references/vendor");
  });
});

const REMOTE_RAW = {
  repository: "ba0918/agentic-workflow",
  revision: "9f1b7c2d4e5a60718293a4b5c6d7e8f90a1b2c3d",
};

/** A fake upstream holding a runtime directory and nothing at any conventional position. */
function remoteRuntime(files: Record<string, string>) {
  return fakeGitHub({
    [REMOTE_RAW.repository]: {
      defaultBranch: "main",
      refs: { main: REMOTE_RAW.revision },
      files: { [REMOTE_RAW.revision]: { "README.md": "# up\n", ...files } },
    },
  });
}

async function withRemoteRawTree<T>(
  files: Record<string, string>,
  fn: (root: string, github: ReturnType<typeof fakeGitHub>) => Promise<T>,
): Promise<T> {
  return await withGoodTree(async (root) => {
    await writeFile(`${root}/.gitignore`, "/.agentic-skill-vendor/\n");
    const github = remoteRuntime(files);
    const added = await runCli(
      ["add", REMOTE_RAW.repository, "workflow", "--root", root],
      github.fetch,
    );
    expect(added.code, added.stderr.join("\n")).toStrictEqual(0);
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "contracts:\n  workflow-runtime:\n    source: workflow\n    files:\n      tools/rt/: scripts/_runtime/\n",
    );
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - changelog-entry\n",
        "    - changelog-entry\n    - workflow-runtime\n",
      ),
    );
    return await fn(root, github);
  });
}

test("a raw-byte contract from another repository is fetched under its src, placed, and verifies without the cache", async () => {
  await withRemoteRawTree(
    {
      "tools/rt/a.py": "A\n",
      "tools/rt/sub/b.py": "B\n",
      "tools/rt-old/c.py": "C\n",
    },
    async (root, github) => {
      const fetched = await runCli(["fetch", "--root", root], github.fetch);
      expect(fetched.code, fetched.stderr.join("\n")).toStrictEqual(0);
      const gen = await runCli(["gen", "--root", root]);
      expect(gen.code, gen.stderr.join("\n")).toStrictEqual(0);
      expect(await fs.readFile(`${root}/${DEST}/sub/b.py`, "utf8")).toBe("B\n");
      await expect(fs.stat(`${root}/${DEST}/c.py`)).rejects.toThrow();
      expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
      await fs.rm(`${root}/.agentic-skill-vendor`, { recursive: true });
      const offline = await runCli(["verify", "--root", root]);
      expect(offline.stdout).toStrictEqual([]);
      expect(offline.code).toStrictEqual(0);
      const blocked = await runCli(["gen", "--root", root]);
      expect(blocked.code).toStrictEqual(2);
      expect(blocked.stderr.join("\n")).toContain("fetch");
    },
  );
});

test("a src the pinned commit does not hold stops the fetch and names the way out", async () => {
  await withRemoteRawTree(
    { "tools/elsewhere/a.py": "A\n" },
    async (root, github) => {
      const fetched = await runCli(["fetch", "--root", root], github.fetch);
      expect(fetched.code).toStrictEqual(2);
      expect(fetched.stderr.join("\n")).toContain("tools/rt/");
      expect(fetched.stderr.join("\n")).toContain("update");
    },
  );
});

test("add and update name a declared id that no conventional position anywhere holds", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - changelog-entry\n",
        "    - changelog-entry\n    - workflow-runtime\n",
      ),
    );
    const github = remoteRuntime({ "tools/rt/a.py": "A\n" });
    const added = await runCli(
      ["add", REMOTE_RAW.repository, "workflow", "--root", root],
      github.fetch,
    );
    expect(added.stdout).toContain(
      "unlocated: workflow-runtime (no canonical text at any conventional location)",
    );
    const updated = await runCli(["update", "--root", root], github.fetch);
    expect(updated.stdout).toContain(
      "unlocated: workflow-runtime (no canonical text at any conventional location)",
    );
  });
});

test("a link on the way to a dest is refused by gen and verify alike", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await fs.rename(
      `${root}/skills/release-notes/scripts`,
      `${root}/skills/release-notes/scripts-real`,
    );
    await fs.symlink("scripts-real", `${root}/skills/release-notes/scripts`);
    const verify = await runCli(["verify", "--root", root]);
    expect(verify.code).toStrictEqual(2);
    expect(verify.stderr.join("\n")).toContain("symlink");
    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code).toStrictEqual(2);
    expect(gen.stderr.join("\n")).toContain("symlink");
  });
});

test("a src at, under or over another contract's conformance position is refused", async () => {
  await withRawTree(async (root) => {
    // changelog-entry keeps its tests at contracts/changelog-entry/conformance.
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "  grab:\n    source: local\n    files:\n      contracts/changelog-entry/: scripts/grab/\n",
    );
    await alsoDeclareIn(root, "review-writer");
    const file = `${root}/skills/review-writer/SKILL.md`;
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        "    - workflow-runtime\n",
        "    - workflow-runtime\n    - grab\n",
      ),
    );
    const gen = await runCli(["gen", "--root", root]);
    expect(gen.code).toStrictEqual(2);
    expect(gen.stderr.join("\n")).toContain("conformance");
  });
});

test("a tree whose lock was lost is recorded anew by claiming every dest it still holds", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const before = await readLockFile(root);
    await fs.rm(`${root}/vendor-lock.json`);
    const result = await runCli(["gen", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(result.stdout).toContain(`claimed: ${DEST} (workflow-runtime)`);
    expect((await readLockFile(root)).placements).toStrictEqual(
      before.placements,
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("swapping the dests of two contracts replaces both in place with nothing swept", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/tools/other/o.txt`, "O\n");
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "  other:\n    source: local\n    files:\n      tools/other/: scripts/other/\n",
    );
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - workflow-runtime\n",
        "    - workflow-runtime\n    - other\n",
      ),
    );
    await runCli(["gen", "--root", root]);
    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8"))
        .replace("scripts/_runtime/", "scripts/SWAP/")
        .replace("scripts/other/", "scripts/_runtime/")
        .replace("scripts/SWAP/", "scripts/other/"),
    );
    const result = await runCli(["gen", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(result.stdout.filter((l) => l.startsWith("cleared:"))).toStrictEqual(
      [],
    );
    expect(await fs.readFile(`${root}/${DEST}/o.txt`, "utf8")).toBe("O\n");
    expect(
      await fs.readFile(
        `${root}/skills/release-notes/scripts/other/runtime.py`,
        "utf8",
      ),
    ).toBe("print('run')\r\n");
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a dest moved under or over its own old place is refused with the two-step way out", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8")).replace(
        "scripts/_runtime/",
        "scripts/_runtime/inner/",
      ),
    );
    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain("nests with");
    expect(result.stderr.join("\n")).toContain("withdraw the declaration");
    // Nothing was written or cleared.
    expect(await fs.readFile(`${root}/${DEST}/runtime.py`, "utf8")).toBe(
      "print('run')\r\n",
    );
    await expect(fs.stat(`${root}/${DEST}/inner`)).rejects.toThrow();
  });
});

test("a run stopped between the copies and the sweep converges on the next gen", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const oldLock = await fs.readFile(`${root}/vendor-lock.json`);
    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8")).replace(
        "scripts/_runtime/",
        "scripts/runtime/",
      ),
    );
    await runCli(["gen", "--root", root]);
    // Put the tree back to "new dest written, old dest swept, lock not yet
    // rewritten" — and further back, to before the sweep, by restoring the
    // old dest from the canonical files the lock's digest still matches.
    await fs.writeFile(`${root}/vendor-lock.json`, oldLock);
    await fs.cp(
      `${root}/skills/release-notes/scripts/runtime`,
      `${root}/${DEST}`,
      {
        recursive: true,
      },
    );
    const result = await runCli(["gen", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(result.stdout).toContain(
      "claimed: skills/release-notes/scripts/runtime (workflow-runtime)",
    );
    expect(result.stdout).toContain(
      "cleared: skills/release-notes/scripts/_runtime/ (workflow-runtime)",
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("switching a dest between directory and file at the same path replaces it in place with nothing swept", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const manifest = `${root}/vendor-manifest.yaml`;
    const asDirectory = await fs.readFile(manifest, "utf8");
    const asFile = asDirectory.replace(
      "      tools/workflow-runtime/: scripts/_runtime/\n",
      "      tools/workflow-runtime/runtime.py: scripts/_runtime\n",
    );

    await fs.writeFile(manifest, asFile);
    const toFile = await runCli(["gen", "--root", root]);
    expect(toFile.code, toFile.stderr.join("\n")).toStrictEqual(0);
    expect(toFile.stdout.join("\n")).not.toContain("cleared:");
    expect(await fs.readFile(`${root}/${DEST}`, "utf8")).toBe(
      "print('run')\r\n",
    );
    const fileLock = await readLockFile(root);
    expect(Object.keys(fileLock.placements["release-notes"])).toStrictEqual([
      "scripts/_runtime",
    ]);
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);

    await fs.writeFile(manifest, asDirectory);
    const toDirectory = await runCli(["gen", "--root", root]);
    expect(toDirectory.code, toDirectory.stderr.join("\n")).toStrictEqual(0);
    expect(toDirectory.stdout.join("\n")).not.toContain("cleared:");
    expect(await fs.readFile(`${root}/${DEST}/lib/helpers.py`, "utf8")).toBe(
      "HELP = 1\n",
    );
    const directoryLock = await readLockFile(root);
    expect(
      Object.keys(directoryLock.placements["release-notes"]),
    ).toStrictEqual(["scripts/_runtime/"]);
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a .gitignore placed inside a directory dest hides nothing: the extra files are drift", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    await writeFile(`${root}/${DEST}/.gitignore`, ".gitignore\nevil.py\n");
    await writeFile(`${root}/${DEST}/evil.py`, "EVIL\n");
    const verify = await runCli(["verify", "--root", root]);
    expect(verify.code).toStrictEqual(1);
    expect(verify.stdout.join("\n")).toContain(`drift: ${DEST}`);
    expect((await runCli(["gen", "--root", root])).code).toStrictEqual(2);
  });
});

test("a file dest whose lock was lost is claimed by the file it holds", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/tools/scripts/run.py`, "RUN\n");
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "  helper-scripts:\n    source: local\n    files:\n      tools/scripts/run.py: scripts/run.py\n",
    );
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - workflow-runtime\n",
        "    - workflow-runtime\n    - helper-scripts\n",
      ),
    );
    await runCli(["gen", "--root", root]);
    const before = await readLockFile(root);
    await fs.rm(`${root}/vendor-lock.json`);
    const result = await runCli(["gen", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(result.stdout).toContain(
      "claimed: skills/release-notes/scripts/run.py (helper-scripts)",
    );
    expect((await readLockFile(root)).placements).toStrictEqual(
      before.placements,
    );
  });
});

test("a directory copied by hand before the tool owned it is claimed without a marker", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/${DEST}/runtime.py`, "print('run')\r\n");
    await writeFile(`${root}/${DEST}/lib/helpers.py`, "HELP = 1\n");
    const result = await runCli(["gen", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(result.stdout).toContain(`claimed: ${DEST} (workflow-runtime)`);
    expect(await fs.exists(`${root}/${DEST}/.vendored`)).toStrictEqual(true);
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a lock placement at a reserved position, or nesting with another, is refused before anything is swept", async () => {
  await withRawTree(async (root) => {
    await runCli(["gen", "--root", root]);
    const lock = await readLockFile(root);
    const placement = lock.placements["release-notes"]["scripts/_runtime/"];
    const skillBefore = await fs.readFile(
      `${root}/skills/release-notes/SKILL.md`,
      "utf8",
    );

    await writeLockFile(root, {
      ...lock,
      placements: {
        "release-notes": {
          "scripts/_runtime/": placement,
          "SKILL.md": { ...placement, src: "tools/x" },
        },
      },
    });
    for (const command of ["gen", "verify"]) {
      const result = await runCli([command, "--root", root]);
      expect(result.code, command).toStrictEqual(2);
      expect(result.stderr.join("\n")).toContain("SKILL.md");
    }
    expect(
      await fs.readFile(`${root}/skills/release-notes/SKILL.md`, "utf8"),
    ).toStrictEqual(skillBefore);

    await writeLockFile(root, {
      ...lock,
      placements: {
        "release-notes": {
          "scripts/_runtime/": placement,
          "scripts/_runtime/lib/": { ...placement, src: "tools/x" },
        },
      },
    });
    const nested = await runCli(["verify", "--root", root]);
    expect(nested.code).toStrictEqual(2);
    expect(nested.stderr.join("\n")).toContain("scripts/_runtime/lib/");
  });
});

test("a file src the tree's ignore rules exclude counts as absent, like a directory src", async () => {
  await withRawTree(async (root) => {
    await writeFile(`${root}/tools/scripts/run.py`, "RUN\n");
    await fs.appendFile(`${root}/.gitignore`, "/tools/scripts/\n");
    await fs.appendFile(
      `${root}/vendor-manifest.yaml`,
      "  helper-scripts:\n    source: local\n    files:\n      tools/scripts/run.py: scripts/run.py\n",
    );
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - workflow-runtime\n",
        "    - workflow-runtime\n    - helper-scripts\n",
      ),
    );
    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(1);
    expect(result.stdout.join("\n")).toContain(
      "closure: helper-scripts is declared by release-notes but tools/scripts/run.py does not exist",
    );
  });
});

test("a closure names the src that is actually absent, not the first row of the contract", async () => {
  await withRawTree(async (root) => {
    const table = `${root}/vendor-manifest.yaml`;
    await fs.writeFile(
      table,
      (await fs.readFile(table, "utf8")).replace(
        "      tools/workflow-runtime/: scripts/_runtime/\n",
        "      tools/workflow-runtime/: scripts/_runtime/\n" +
          "      tools/absent.py: scripts/absent.py\n",
      ),
    );
    const result = await runCli(["gen", "--root", root]);
    expect(result.code).toStrictEqual(1);
    expect(result.stdout.join("\n")).toContain(
      "closure: workflow-runtime is declared by release-notes but tools/absent.py does not exist",
    );
  });
});

test("a .vendored at the top of a remote directory src is refused with the way out named", async () => {
  await withRemoteRawTree(
    { "tools/rt/a.py": "A\n", "tools/rt/.vendored": "x" },
    async (root, github) => {
      const fetched = await runCli(["fetch", "--root", root], github.fetch);
      expect(fetched.code).toStrictEqual(2);
      expect(fetched.stderr.join("\n")).toContain("tools/rt/.vendored");
      expect(fetched.stderr.join("\n")).toContain("edit the files line");
    },
  );
});
