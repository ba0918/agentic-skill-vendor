import {
  replaceWithSymlink,
  runCli,
  snapshotTree,
  thrownBy,
  withGoodTree,
} from "./testing.ts";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError } from "./errors.ts";
import { parseContractDeclarations } from "./declaration.ts";

function skill(frontmatter: string): string {
  return `---\nname: sample\n${frontmatter}---\n\n# Sample\n\nBody.\n`;
}

function parse(frontmatter: string): string[] {
  return parseContractDeclarations(
    skill(frontmatter),
    "skills/sample/SKILL.md",
  );
}

/**
 * Requires the frontmatter to be refused, and refused for the stated reason.
 *
 * The message fragment is not decoration. Several of these shapes are refused
 * by more than one thing — the YAML parser has its own opinion about a tab, and
 * a schema rule and a parse failure look identical from the outside — so a case
 * that checked only the error class would keep passing with the guard it names
 * removed. Naming the reason is what makes each case answer for its own guard.
 */
function assertRefused(frontmatter: string, because: string): void {
  expect(thrownBy(() => parse(frontmatter), ConfigError).message).toContain(
    because,
  );
}

test("contract ids are read in declaration order", () => {
  expect(
    parse(
      "metadata:\n  contracts:\n    - verdict-format\n    - changelog-entry\n",
    ),
  ).toStrictEqual(["verdict-format", "changelog-entry"]);
});

test("a skill with no metadata block declares nothing", () => {
  expect(parse("")).toStrictEqual([]);
});

test("a skill whose metadata holds no contracts key declares nothing", () => {
  expect(parse("metadata:\n  audience: internal\n")).toStrictEqual([]);
});

test("a skill with no frontmatter at all declares nothing", () => {
  expect(
    parseContractDeclarations("# Sample\n\nBody.\n", "skills/sample/SKILL.md"),
  ).toStrictEqual([]);
});

test("metadata children indented four spaces still declare their contracts", () => {
  expect(
    parse("metadata:\n    contracts:\n        - verdict-format\n"),
  ).toStrictEqual(["verdict-format"]);
});

test("a trailing comment on a key does not drop the declarations under it", () => {
  expect(
    parse(
      "metadata: # pins live here\n  contracts: # one per line\n    - verdict-format\n",
    ),
  ).toStrictEqual(["verdict-format"]);
});

test("a comment line inside the list does not drop the declarations around it", () => {
  expect(
    parse(
      "metadata:\n  contracts:\n    # the report shape\n    - verdict-format\n",
    ),
  ).toStrictEqual(["verdict-format"]);
});

test("an entry that carries a digest is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - id: verdict-format\n      digest: sha256:" +
      "0".repeat(64) +
      "\n",
    "metadata.contracts entries name a contract id and nothing else",
  );
});

test("declaring the same contract twice is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - verdict-format\n    - verdict-format\n",
    "contract declared more than once",
  );
});

test("a flow-style contracts list declares its contracts", () => {
  expect(
    parse("metadata:\n  contracts: [verdict-format, changelog-entry]\n"),
  ).toStrictEqual(["verdict-format", "changelog-entry"]);
});

test("a flow-style metadata mapping declares its contracts", () => {
  expect(parse("metadata: {contracts: [verdict-format]}\n")).toStrictEqual([
    "verdict-format",
  ]);
});

test("list items at the contracts key indent declare their contracts", () => {
  expect(parse("metadata:\n  contracts:\n  - verdict-format\n")).toStrictEqual([
    "verdict-format",
  ]);
});

test("a quoted contract id declares the same contract as a bare one", () => {
  expect(
    parse('metadata:\n  contracts:\n    - "verdict-format"\n'),
  ).toStrictEqual(["verdict-format"]);
});

test("a contracts key with no entries under it is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n",
    "metadata.contracts must be a list of contract ids",
  );
});

test("an empty contracts list is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts: []\n",
    "metadata.contracts is present but declares no contract",
  );
});

test("a contracts value that is not a list is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts: verdict-format\n",
    "metadata.contracts must be a list of contract ids",
  );
});

test("an entry that is not a string is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - 12\n",
    "metadata.contracts entries must be contract ids written as text",
  );
});

test("an empty entry in the contracts list is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    -\n",
    "metadata.contracts entries must be contract ids written as text",
  );
});

test("a metadata key that is not a mapping is a configuration error", () => {
  assertRefused("metadata: internal\n", "metadata must be a mapping");
});

test("a metadata key with no value at all is a configuration error", () => {
  assertRefused("metadata:\n", "metadata must be a mapping");
});

test("frontmatter that is not a mapping is a configuration error", () => {
  expect(() =>
    parseContractDeclarations(
      "---\n- verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a metadata key indented under nothing is a configuration error", () => {
  // The shape that was read as "this skill declares nothing" before: the key is
  // indented, so it belongs to no mapping the document opens.
  assertRefused(
    " metadata:\n   contracts:\n     - verdict-format\n",
    "frontmatter is not readable YAML",
  );
});

test("a tab-indented contracts key is a configuration error", () => {
  // YAML forbids a tab in indentation, but the parser tolerates one and reads
  // the key as a sibling of metadata rather than a child of it. Refusing the
  // tab at the boundary is what keeps that reinterpretation from answering
  // "declares nothing" for a skill that declared something.
  assertRefused(
    "metadata:\n  audience: internal\n\tcontracts:\n\t  - verdict\n",
    "frontmatter is indented with a tab",
  );
});

test("a tab-indented contracts entry is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n\t- verdict-format\n",
    "frontmatter is indented with a tab",
  );
});

test("a delimiter line further down the document opens no second declaration block", () => {
  expect(
    parseContractDeclarations(
      "---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n\n" +
        "---\nmetadata:\n  contracts:\n    - changelog-entry\n---\n",
      "skills/sample/SKILL.md",
    ),
  ).toStrictEqual(["verdict-format"]);
});

test("an unusable contract id in a declaration is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - ../escape\n",
    "not a usable contract id",
  );
});

test("a second metadata key holding the contracts is a configuration error", () => {
  assertRefused(
    "metadata:\n  audience: internal\nmetadata:\n  contracts:\n    - verdict-format\n",
    "frontmatter is not readable YAML",
  );
});

test("a contracts key indented deeper than its sibling keys is a configuration error", () => {
  assertRefused(
    "metadata:\n  audience: internal\n    contracts:\n      - verdict-format\n",
    "frontmatter is not readable YAML",
  );
});

test("a contracts key indented shallower than its sibling keys is a configuration error", () => {
  assertRefused(
    "metadata:\n    audience: internal\n  contracts:\n    - verdict-format\n",
    "frontmatter is not readable YAML",
  );
});

test("a second contracts key in the same metadata block is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - verdict-format\n  contracts:\n    - changelog-entry\n",
    "frontmatter is not readable YAML",
  );
});

test("frontmatter that cannot be read names the file it came from", () => {
  const error = thrownBy(
    () => parse("metadata:\n  contracts:\n    - a\n  contracts:\n    - b\n"),
    ConfigError,
  );
  expect(error.message).toContain("skills/sample/SKILL.md");
});

test("frontmatter opened but never closed is a configuration error", () => {
  expect(() =>
    parseContractDeclarations(
      "---\nname: sample\nmetadata:\n  contracts:\n    - verdict-format\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("an opening delimiter carrying a trailing space is a configuration error", () => {
  // Invisible in every editor, survives copy-paste, and tolerated by the
  // frontmatter readers skill authors are used to. Read as "no frontmatter" it
  // would drop the whole block without a word.
  expect(() =>
    parseContractDeclarations(
      "--- \nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("an opening delimiter carrying a leading space is a configuration error", () => {
  expect(() =>
    parseContractDeclarations(
      " ---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a document whose lines end with a lone carriage return is a configuration error", () => {
  expect(() =>
    parseContractDeclarations(
      "---\rmetadata:\r  contracts:\r    - verdict-format\r---\r\r# Sample\r",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("an opening delimiter carrying a zero-width character is a configuration error", () => {
  // A zero-width space survives `trim`, which strips U+00A0 and U+FEFF but not
  // this range. Read as "no frontmatter" the whole declaration block would be
  // dropped without a word, which is the failure this tool exists to prevent.
  expect(() =>
    parseContractDeclarations(
      "\u200b---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a zero-width character after the opening delimiter is a configuration error", () => {
  expect(() =>
    parseContractDeclarations(
      "---\u200d\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a document reaching its opening delimiter only after a blank line is a configuration error", () => {
  // The delimiter is the first thing the document says or it separates nothing.
  // Reading a leading blank line as "this document has no frontmatter" would
  // unpin the skill silently.
  expect(() =>
    parseContractDeclarations(
      "\n---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a first line holding only zero-width characters does not hide the delimiter under it", () => {
  expect(() =>
    parseContractDeclarations(
      "\u200b\n---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("an opening delimiter carrying an invisible character YAML has no name for is a configuration error", () => {
  // U+200B..U+200D are the ones that were measured, but they are instances of
  // a class: a character a renderer shows as nothing and `trim` does not
  // remove. A word joiner is one of the others.
  expect(() =>
    parseContractDeclarations(
      "⁠---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a metadata block assembled through a merge key declares its contracts", () => {
  // A merge key is one of YAML's spellings of "these entries belong here", and
  // the parser this tool used before read it. A parser that leaves `<<` as a
  // literal key answers "declares nothing" for a skill that declared two.
  expect(
    parseContractDeclarations(
      "---\ndefaults: &d\n  contracts:\n    - verdict-format\n    - changelog-entry\n" +
        "metadata:\n  <<: *d\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toStrictEqual(["verdict-format", "changelog-entry"]);
});

test("a delimiter reached after a lone carriage return is a configuration error", () => {
  // Every editor draws a lone carriage return as a line break, so this is the
  // leading-blank-line shape as a reader sees it, whatever the byte says.
  expect(() =>
    parseContractDeclarations(
      "\r---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

test("a delimiter behind a character that draws as blank is a configuration error", () => {
  // A braille blank is a graphic character, so Unicode does not file it with
  // the ones a renderer shows as nothing — but a reader sees indentation, and
  // an indented delimiter is already refused.
  expect(() =>
    parseContractDeclarations(
      "⠀---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
      "skills/sample/SKILL.md",
    ),
  ).toThrow(ConfigError);
});

// The file-type half of the silent-unpin family. Every earlier shape was about
// what a SKILL.md holds; this one is about what stands at its path. Read as
// "this skill has no SKILL.md", anything that is not a file retires every
// contract the skill declares without a word — gen deletes the vendored copies
// as unaccounted for and finishes at 0, and verify then calls that clean.
//
// A skill genuinely holding no SKILL.md keeps declaring nothing, and its
// directory keeps being scanned for copies no declaration accounts for.

const SKILL_FILE = "skills/review-writer/SKILL.md";

test("every command refuses a SKILL.md that is there but is not a regular file", async () => {
  await withGoodTree(async (root) => {
    await fs.rm(`${root}/${SKILL_FILE}`);
    await fs.mkdir(`${root}/${SKILL_FILE}`);
    const before = await snapshotTree(root);

    for (const command of [["gen"], ["verify"], ["accept", "verdict-format"]]) {
      const result = await runCli([...command, "--root", root]);
      expect(result.code, command[0]).toStrictEqual(2);
      expect(result.stdout, command[0]).toStrictEqual([]);
      expect(result.stderr.join("\n"), command[0]).toContain(
        `${SKILL_FILE}: not a regular file`,
      );
    }
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});

test("a SKILL.md that is a named pipe is refused rather than read as absent", async () => {
  await withGoodTree(async (root) => {
    // The shape that shows the refusal is about the kind of file rather than
    // about directories. Nothing here reads it, and nothing may: opening a pipe
    // to read blocks until something on the other side writes — which is why
    // this case states the exit and the message and never snapshots the tree.
    await fs.rm(`${root}/${SKILL_FILE}`);
    await promisify(execFile)("mkfifo", [`${root}/${SKILL_FILE}`]);

    const result = await runCli(["verify", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stdout).toStrictEqual([]);
    expect(result.stderr.join("\n")).toContain(
      `${SKILL_FILE}: not a regular file`,
    );
  });
});

test("a SKILL.md replaced by a symlink is refused as a link, not as a kind", async () => {
  await withGoodTree(async (root) => {
    // Both refusals fit this shape, and which one speaks decides what the
    // reader goes looking for: a link planted inside the tree, or a file of the
    // wrong kind standing where the declaration belongs. The link is the more
    // specific fact, so it is the one named.
    await replaceWithSymlink(
      `${root}/${SKILL_FILE}`,
      `${root}/skills/release-notes/SKILL.md`,
    );

    const result = await runCli(["verify", "--root", root]);
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain(
      `symlink is not allowed inside the tree: ${SKILL_FILE}`,
    );
  });
});

// A skill directory replaced by something that is not a directory. Skipped as
// "not a skill", the declarations it held stop being seen, so the lock is
// rewritten without it and its vendored copies go with it — a whole skill
// retired by a file appearing over it.
//
// What separates that from a stray file someone dropped under skills/ is the
// lock: it records the skills the tree had. A name it names must be a
// directory; a name it has never heard of is not this tool's business.

const CLOBBERED = "skills/review-writer";

test("a name the lock records must be a directory, whatever now stands there", async () => {
  for (const plant of ["file", "pipe"] as const) {
    await withGoodTree(async (root) => {
      await fs.rm(`${root}/${CLOBBERED}`, { recursive: true });
      if (plant === "file") {
        await fs.writeFile(`${root}/${CLOBBERED}`, "not a directory\n");
      } else {
        await promisify(execFile)("mkfifo", [`${root}/${CLOBBERED}`]);
      }
      const manifestBefore = await fs.readFile(
        `${root}/vendor-manifest.json`,
        "utf8",
      );

      for (const command of [
        ["gen"],
        ["verify"],
        ["accept", "changelog-entry"],
      ]) {
        const where = `${plant} / ${command[0]}`;
        const result = await runCli([...command, "--root", root]);
        expect(result.code, where).toStrictEqual(2);
        expect(result.stdout, where).toStrictEqual([]);
        expect(result.stderr.join("\n"), where).toContain(
          `${CLOBBERED} is recorded in the lock but is not a directory`,
        );
      }
      expect(
        await fs.readFile(`${root}/vendor-manifest.json`, "utf8"),
      ).toStrictEqual(manifestBefore);
    });
  }
});

test("a stray file under skills that the lock never named is left alone", async () => {
  await withGoodTree(async (root) => {
    // A consuming repository may keep anything it likes beside its skills. No
    // layout rule is being declared here — only that a skill the lock knows
    // about cannot quietly stop being one.
    await fs.writeFile(`${root}/skills/README.md`, "# skills\n");
    const before = await snapshotTree(root);

    for (const command of [
      ["gen"],
      ["verify"],
      ["accept", "changelog-entry"],
    ]) {
      const result = await runCli([...command, "--root", root]);
      expect(result.code, command[0]).toStrictEqual(0);
    }
    expect(await snapshotTree(root)).toStrictEqual(before);
  });
});

test("a skill directory removed altogether is still a removal", async () => {
  await withGoodTree(async (root) => {
    // The legitimate counterpart, and the reason the guard asks what stands
    // there rather than whether the name is still present: a skill that was
    // deleted is a change to the tree the lock is meant to follow.
    await fs.rm(`${root}/${CLOBBERED}`, { recursive: true });

    expect((await runCli(["gen", "--root", root])).code).toStrictEqual(0);
    const lock = JSON.parse(
      await fs.readFile(`${root}/vendor-manifest.json`, "utf8"),
    ).lock;
    expect(Object.keys(lock.dependencies)).toStrictEqual(["release-notes"]);
  });
});

test("a skill whose name is a prototype key survives the whole round trip", async () => {
  await withGoodTree(async (root) => {
    // `__proto__` is an ordinary directory name on disk, and skill names are
    // directory names — nothing validates them, and nothing should: a naming
    // rule invented here would constrain a layout the specification never
    // constrained. Assigned into a plain object, though, that one name writes
    // the object's prototype instead of a key, and the skill disappears from
    // both Object.keys and JSON: the lock was written without it at exit 0 and
    // verify, building its expectation the same way, called that clean.
    await fs.cp(`${root}/skills/review-writer`, `${root}/skills/__proto__`, {
      recursive: true,
    });
    await fs.writeFile(
      `${root}/skills/__proto__/SKILL.md`,
      "---\nname: proto\ndescription: d\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# P\n",
    );

    expect((await runCli(["gen", "--root", root])).code).toStrictEqual(0);

    const raw = await fs.readFile(`${root}/vendor-manifest.json`, "utf8");
    const dependencies = JSON.parse(raw).lock.dependencies;
    expect(raw).toContain('"__proto__"');
    expect(Object.hasOwn(dependencies, "__proto__")).toStrictEqual(true);
    expect(Object.keys(dependencies)).toStrictEqual([
      "__proto__",
      "release-notes",
      "review-writer",
    ]);
    // Read through the descriptor: the accessor of that name would answer with
    // the prototype rather than the key the manifest actually carries.
    expect(
      Object.getOwnPropertyDescriptor(dependencies, "__proto__")?.value,
    ).toStrictEqual(["verdict-format"]);

    const verified = await runCli(["verify", "--root", root]);
    expect(verified.code, verified.stdout.join("\n")).toStrictEqual(0);

    expect((await runCli(["gen", "--root", root])).code).toStrictEqual(0);
    expect(
      await fs.readFile(`${root}/vendor-manifest.json`, "utf8"),
    ).toStrictEqual(raw);
  });
});
