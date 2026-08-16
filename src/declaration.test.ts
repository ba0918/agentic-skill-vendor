import { thrownBy } from "./testing.ts";
import { expect, test } from "bun:test";
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

function assertRefused(frontmatter: string): void {
  expect(() => parse(frontmatter)).toThrow(ConfigError);
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
  );
});

test("declaring the same contract twice is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - verdict-format\n    - verdict-format\n",
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
  assertRefused("metadata:\n  contracts:\n");
});

test("an empty contracts list is a configuration error", () => {
  assertRefused("metadata:\n  contracts: []\n");
});

test("a contracts value that is not a list is a configuration error", () => {
  assertRefused("metadata:\n  contracts: verdict-format\n");
});

test("an entry that is not a string is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n    - 12\n");
});

test("an empty entry in the contracts list is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n    -\n");
});

test("a metadata key that is not a mapping is a configuration error", () => {
  assertRefused("metadata: internal\n");
});

test("a metadata key with no value at all is a configuration error", () => {
  assertRefused("metadata:\n");
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
  assertRefused(" metadata:\n   contracts:\n     - verdict-format\n");
});

test("a tab-indented contracts key is a configuration error", () => {
  // YAML forbids a tab in indentation, but the parser tolerates one and reads
  // the key as a sibling of metadata rather than a child of it. Refusing the
  // tab at the boundary is what keeps that reinterpretation from answering
  // "declares nothing" for a skill that declared something.
  assertRefused(
    "metadata:\n  audience: internal\n\tcontracts:\n\t  - verdict\n",
  );
});

test("a tab-indented contracts entry is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n\t- verdict-format\n");
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
  assertRefused("metadata:\n  contracts:\n    - ../escape\n");
});

test("a second metadata key holding the contracts is a configuration error", () => {
  assertRefused(
    "metadata:\n  audience: internal\nmetadata:\n  contracts:\n    - verdict-format\n",
  );
});

test("a contracts key indented deeper than its sibling keys is a configuration error", () => {
  assertRefused(
    "metadata:\n  audience: internal\n    contracts:\n      - verdict-format\n",
  );
});

test("a contracts key indented shallower than its sibling keys is a configuration error", () => {
  assertRefused(
    "metadata:\n    audience: internal\n  contracts:\n    - verdict-format\n",
  );
});

test("a second contracts key in the same metadata block is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - verdict-format\n  contracts:\n    - changelog-entry\n",
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
