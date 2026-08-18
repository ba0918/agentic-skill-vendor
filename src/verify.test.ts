import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  append,
  kindsOf,
  PERMISSIONS_APPLY,
  replaceWithSymlink,
  runCli,
  withGoodTree,
  writeFile,
} from "./testing.ts";

const COPY = "skills/review-writer/references/vendor/verdict-format.md";
const CONTRACT = "contracts/verdict-format.md";
const LOCK = "vendor-lock.json";
const CONFORMANCE = "contracts/changelog-entry/conformance/cases/minimal.md";

async function verify(root: string) {
  return await runCli(["verify", "--root", root]);
}

test("a skill name with control bytes is quoted in the extra finding", async () => {
  await withGoodTree(async (root) => {
    // The report lines carry the same tree-supplied names as the refusals, and
    // a name holding an ANSI escape would paint the CI log exactly where the
    // guard was added. The extra finding must quote it the same way.
    const name = "esc\u001b[31m";
    await writeFile(
      `${root}/skills/${name}/references/vendor/stray.md`,
      "stray\n",
    );
    const result = await verify(root);
    expect(result.code).toStrictEqual(1);
    const extra = result.stdout.find((line) => line.startsWith("extra:"));
    expect(extra).toBeDefined();
    expect(extra).not.toContain("\u001b");
    expect(extra).toContain("\\u001b");
  });
});

test("a freshly generated tree verifies clean", async () => {
  await withGoodTree(async (root) => {
    const result = await verify(root);
    expect(result.stdout).toStrictEqual([]);
    expect(result.code).toStrictEqual(0);
  });
});

test("a hand-edited vendored copy is reported as drift", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${COPY}`, "\nEdited by hand after generation.\n");
    const result = await verify(root);
    expect(result.code).toStrictEqual(1);
    expect(kindsOf(result.stdout)).toStrictEqual(["drift"]);
    expect(result.stdout[0]).toContain(COPY);
  });
});

test("a missing vendored copy is reported as drift", async () => {
  await withGoodTree(async (root) => {
    await fs.rm(`${root}/${COPY}`);
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual(["drift"]);
  });
});

test("a vendored copy whose header was rewritten is reported as drift", async () => {
  await withGoodTree(async (root) => {
    const text = await fs.readFile(`${root}/${COPY}`, "utf8");
    await fs.writeFile(
      `${root}/${COPY}`,
      text.replace(
        "<!-- contract: verdict-format -->",
        "<!-- contract: other -->",
      ),
    );
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual(["drift"]);
  });
});

test("a vendored copy that is not valid UTF-8 is drift, not a configuration error", async () => {
  await withGoodTree(async (root) => {
    await fs.writeFile(`${root}/${COPY}`, new Uint8Array([0xff, 0xfe, 0x00]));
    const result = await verify(root);
    expect(result.code).toStrictEqual(1);
    expect(kindsOf(result.stdout)).toStrictEqual(["drift"]);
  });
});

test("a vendored file no declaration accounts for is reported as extra", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/skills/release-notes/references/vendor/orphan.md`,
      "left behind\n",
    );
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual(["extra"]);
  });
});

test("a subdirectory inside a vendor directory is reported as extra", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/skills/release-notes/references/vendor/nested/thing.md`,
      "nested\n",
    );
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual(["extra"]);
  });
});

test("a vendored copy under a directory holding no SKILL.md is reported as extra", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/skills/note-taker/references/vendor/changelog-entry.md`,
      "not declared by anything\n",
    );
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual(["extra"]);
  });
});

test("a declared contract with no canonical file is reported as a closure gap", async () => {
  await withGoodTree(async (root) => {
    await fs.rm(`${root}/${CONTRACT}`);
    const kinds = kindsOf((await verify(root)).stdout);
    expect(kinds.includes("closure"), kinds.join(",")).toStrictEqual(true);
  });
});

test("canonical text ahead of the lock is a stale lock, and the copies still verify", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    const result = await verify(root);
    expect(result.code).toStrictEqual(1);
    // The copies still match what the lock records, so the one finding is that
    // the lock was never rewritten over the edit. This is the state CI exists
    // to detect: the edit landed and gen was not run.
    expect(kindsOf(result.stdout)).toStrictEqual(["stale-lock"]);
  });
});

test("a copy edited while the canonical text also moved is reported on both counts", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    await append(`${root}/${COPY}`, "\nAlso edited by hand.\n");
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual([
      "drift",
      "stale-lock",
    ]);
  });
});

test("a contract with no resolution is reported as unresolved", async () => {
  await withGoodTree(async (root) => {
    const lock = JSON.parse(await fs.readFile(`${root}/${LOCK}`, "utf8"));
    delete lock.resolutions["verdict-format"];
    await fs.writeFile(`${root}/${LOCK}`, JSON.stringify(lock, null, 2) + "\n");
    const kinds = kindsOf((await verify(root)).stdout);
    expect(kinds.includes("unresolved"), kinds.join(",")).toStrictEqual(true);
  });
});

test("a hand-edited lock is reported as a lock mismatch", async () => {
  await withGoodTree(async (root) => {
    const lock = JSON.parse(await fs.readFile(`${root}/${LOCK}`, "utf8"));
    // A key the reader consumes nothing of, so nothing but the byte comparison
    // against what the tree renders to can notice it. The lock used to
    // record the tool's own version in exactly this position, and it is gone
    // for the same reason this edit is a finding: a value in the compared bytes
    // that no check reads.
    lock.generator = { version: "9.9.9" };
    await fs.writeFile(`${root}/${LOCK}`, JSON.stringify(lock, null, 2) + "\n");
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual(["lock"]);
  });
});

test("a missing lock is reported rather than treated as an empty tree", async () => {
  await withGoodTree(async (root) => {
    await fs.rm(`${root}/${LOCK}`);
    const kinds = kindsOf((await verify(root)).stdout);
    expect(kinds.includes("lock"), kinds.join(",")).toStrictEqual(true);
    expect(kinds.includes("unresolved"), kinds.join(",")).toStrictEqual(true);
  });
});

test("a declaration added without regenerating is reported as a lock mismatch", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(
      skill,
      (await fs.readFile(skill, "utf8")).replace(
        "    - changelog-entry\n",
        "    - changelog-entry\n    - verdict-format\n",
      ),
    );
    const kinds = kindsOf((await verify(root)).stdout);
    expect(kinds.includes("lock"), kinds.join(",")).toStrictEqual(true);
    expect(kinds.includes("drift"), kinds.join(",")).toStrictEqual(true);
  });
});

test("an edited conformance test is reported as a conformance mismatch", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONFORMANCE}`, "\nAn extra expectation.\n");
    const result = await verify(root);
    expect(result.code).toStrictEqual(1);
    // Reported once. The locked value stays in the lock comparison, so the
    // same divergence is not counted a second time as a stale lock.
    expect(kindsOf(result.stdout)).toStrictEqual(["conformance-mismatch"]);
  });
});

test("an added conformance file is reported as a conformance mismatch", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/changelog-entry/conformance/cases/second.md`,
      "another case\n",
    );
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual([
      "conformance-mismatch",
    ]);
  });
});

test("removing the whole conformance directory is reported as a conformance mismatch", async () => {
  await withGoodTree(async (root) => {
    await fs.rm(`${root}/contracts/changelog-entry`, { recursive: true });
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual([
      "conformance-mismatch",
    ]);
  });
});

test("a contract gaining conformance tests the lock records none for is reported", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/verdict-format/conformance/cases/first.md`,
      "a new case\n",
    );
    expect(kindsOf((await verify(root)).stdout)).toStrictEqual([
      "conformance-mismatch",
    ]);
  });
});

test("a conformance directory holding only ignored files still counts as absent", async () => {
  await withGoodTree(async (root) => {
    await writeFile(`${root}/.gitignore`, "*.pyc\n");
    await writeFile(
      `${root}/contracts/verdict-format/conformance/x.pyc`,
      "compiled\n",
    );
    expect((await verify(root)).code).toStrictEqual(0);
  });
});

const describeWrite = PERMISSIONS_APPLY ? test : test.skip;

describeWrite(
  "verify reports the state a run interrupted part way through leaves",
  async () => {
    await withGoodTree(async (root) => {
      // The interruption has to be one that leaves a tree verify can still
      // read, which is what a vendor directory nothing may write into gives:
      // gen stops where it stands, every file already in the tree stays
      // readable, and the copy deleted beforehand is still missing. A file of
      // the wrong kind would do the stopping too, but verify refuses that tree
      // rather than reporting it — the same answer gen gives, by design.
      const blocked = `${root}/skills/release-notes/references/vendor`;
      await fs.rm(`${root}/${COPY}`);
      const { mode } = await fs.stat(blocked);
      await fs.chmod(blocked, 0o555);
      try {
        expect((await runCli(["gen", "--root", root])).code).toStrictEqual(2);
        const result = await verify(root);
        expect(result.code).toStrictEqual(1);
        expect(result.stdout.join("\n")).toContain(`drift: ${COPY} is missing`);
      } finally {
        await fs.chmod(blocked, mode);
      }
    });
  },
);

test("verify refuses a vendor directory symlinked outside the tree", async () => {
  await withGoodTree(async (root) => {
    const outside = `${root.slice(0, root.lastIndexOf("/"))}/outside`;
    await fs.mkdir(outside, { recursive: true });
    await replaceWithSymlink(
      `${root}/skills/release-notes/references/vendor`,
      outside,
    );
    const result = await verify(root);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
  });
});

test("a SKILL.md with unclosed frontmatter makes verify exit 2", async () => {
  await withGoodTree(async (root) => {
    await fs.writeFile(
      `${root}/skills/release-notes/SKILL.md`,
      "---\nname: release-notes\n\n# Release Notes\n",
    );
    const result = await verify(root);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain("error:");
  });
});

test("a contract that is not valid UTF-8 makes verify exit 2", async () => {
  await withGoodTree(async (root) => {
    await fs.writeFile(
      `${root}/${CONTRACT}`,
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    const result = await verify(root);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
  });
});

test("a SKILL.md whose opening delimiter carries a zero-width character makes verify exit 2", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    const lines = (await fs.readFile(skill, "utf8")).split("\n");
    lines[0] = "\u200b---";
    await fs.writeFile(skill, lines.join("\n"));

    const result = await verify(root);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain("error:");
  });
});

test("a SKILL.md reaching its opening delimiter only after a blank line makes verify exit 2", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(skill, "\n" + (await fs.readFile(skill, "utf8")));

    const result = await verify(root);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain("error:");
  });
});
