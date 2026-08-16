import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { runCli, snapshotTree, withGoodTree, writeFile } from "./testing.ts";

const CONTRACT = "contracts/verdict-format.md";
const COPY = "skills/review-writer/references/vendor/verdict-format.md";
const MANIFEST = "vendor-manifest.json";
const CONFORMANCE = "contracts/changelog-entry/conformance/cases/minimal.md";

// deno-lint-ignore no-explicit-any
type Json = any;

async function readManifest(root: string): Promise<Json> {
  return JSON.parse(await fs.readFile(`${root}/${MANIFEST}`, "utf8"));
}

async function writeManifest(root: string, manifest: Json): Promise<void> {
  await fs.writeFile(
    `${root}/${MANIFEST}`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

async function append(path: string, text: string): Promise<void> {
  await fs.writeFile(path, (await fs.readFile(path, "utf8")) + text);
}

async function forget(root: string, id: string): Promise<void> {
  const manifest = await readManifest(root);
  delete manifest.lock.resolutions[id];
  await writeManifest(root, manifest);
}

test("accepting a contract for the first time records its resolution", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    expect((await runCli(["gen", "--root", root])).code).toStrictEqual(1);

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(
      (await readManifest(root)).lock.resolutions["verdict-format"].digest,
    ).toContain("sha256:");
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("a first adoption is reported as having no previous digest", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    const result = await runCli(["accept", "verdict-format", "--root", root]);
    expect(result.stdout[0]).toStrictEqual("accepted: verdict-format");
    expect(result.stdout[1]).toStrictEqual(
      "  old-digest: none (initial adoption)",
    );
  });
});

test("accepting an updated contract reports the old digest, the new one and its dependents", async () => {
  await withGoodTree(async (root) => {
    const before = (await readManifest(root)).lock.resolutions["verdict-format"]
      .digest;
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    const after = (await readManifest(root)).lock.resolutions["verdict-format"]
      .digest;
    expect(result.stdout).toStrictEqual([
      "accepted: verdict-format",
      `  old-digest: ${before}`,
      `  new-digest: ${after}`,
      "  dependents: review-writer",
    ]);
    expect(after === before).toStrictEqual(false);
  });
});

test("a contract no skill declares is accepted with no dependents", async () => {
  await withGoodTree(async (root) => {
    await writeFile(
      `${root}/contracts/orphan-contract.md`,
      "# Orphan\n\nDeclared by nobody yet.\n",
    );

    const result = await runCli(["accept", "orphan-contract", "--root", root]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(result.stdout[3]).toStrictEqual("  dependents: (none)");
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("accepting an updated contract leaves every SKILL.md untouched", async () => {
  await withGoodTree(async (root) => {
    const before = await snapshotTree(root);
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    expect(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
    ).toStrictEqual(0);
    const after = await snapshotTree(root);

    for (const path of [...before.keys()].filter((p) =>
      p.endsWith("SKILL.md"),
    )) {
      expect(after.get(path), path).toStrictEqual(before.get(path));
    }
    // What a contract update is allowed to move: the lock and the copies.
    expect(after.get(MANIFEST) === before.get(MANIFEST)).toStrictEqual(false);
    expect(after.get(COPY) === before.get(COPY)).toStrictEqual(false);
  });
});

test("accepting rewrites the vendored copies to the newly accepted text", async () => {
  await withGoodTree(async (root) => {
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    expect(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
    ).toStrictEqual(0);
    expect(await fs.readFile(`${root}/${COPY}`, "utf8")).toContain(
      "- One further rule.",
    );
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("accepting adopts the conformance tree alongside the text", async () => {
  await withGoodTree(async (root) => {
    const before = (await readManifest(root)).lock.resolutions[
      "changelog-entry"
    ].conformance;
    await append(`${root}/${CONFORMANCE}`, "\nAnd one more expectation.\n");

    expect(
      (await runCli(["accept", "changelog-entry", "--root", root])).code,
    ).toStrictEqual(0);
    const after = (await readManifest(root)).lock.resolutions["changelog-entry"]
      .conformance;
    expect(after === before).toStrictEqual(false);
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("accepting records the version written in the contract frontmatter", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    expect(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
    ).toStrictEqual(0);
    expect(
      (await readManifest(root)).lock.resolutions["verdict-format"].version,
    ).toStrictEqual("1.2.0");
  });
});

test("accepting one contract leaves the resolution of another alone", async () => {
  await withGoodTree(async (root) => {
    const before = (await readManifest(root)).lock.resolutions[
      "changelog-entry"
    ];
    await append(`${root}/${CONTRACT}`, "\n- One further rule.\n");
    expect(
      (await runCli(["accept", "verdict-format", "--root", root])).code,
    ).toStrictEqual(0);
    expect(
      (await readManifest(root)).lock.resolutions["changelog-entry"],
    ).toStrictEqual(before);
  });
});

test("accepting several contracts in one run reports each of them", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    await forget(root, "changelog-entry");

    const result = await runCli([
      "accept",
      "verdict-format",
      "changelog-entry",
      "--root",
      root,
    ]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(
      result.stdout.filter((l) => l.startsWith("accepted: ")).length,
    ).toStrictEqual(2);
    expect((await runCli(["verify", "--root", root])).code).toStrictEqual(0);
  });
});

test("accepting writes nothing while another declared contract stays unaccepted", async () => {
  await withGoodTree(async (root) => {
    await forget(root, "verdict-format");
    await forget(root, "changelog-entry");
    const before = await snapshotTree(root);

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    expect(result.code).toStrictEqual(1);
    expect(
      result.stdout.some((l) => l.startsWith("unresolved:")),
    ).toStrictEqual(true);
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});

test("accepting a contract with no canonical file is a usage error", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli(["accept", "no-such-contract", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain("no-such-contract");
  });
});

test("accepting an unusable contract id is a usage error", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli(["accept", "../escape", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
  });
});

test("accepting with no contract named is a usage error", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli(["accept", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
  });
});

test("accepting refuses a skill whose opening delimiter carries a zero-width character", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    const lines = (await fs.readFile(skill, "utf8")).split("\n");
    lines[0] = "\u200b---";
    await fs.writeFile(skill, lines.join("\n"));
    const before = await snapshotTree(root);

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});

test("accepting refuses a skill reaching its opening delimiter only after a blank line", async () => {
  await withGoodTree(async (root) => {
    const skill = `${root}/skills/release-notes/SKILL.md`;
    await fs.writeFile(skill, "\n" + (await fs.readFile(skill, "utf8")));
    const before = await snapshotTree(root);

    const result = await runCli(["accept", "verdict-format", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});
