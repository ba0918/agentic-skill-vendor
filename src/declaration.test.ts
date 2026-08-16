import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  assertThrows(() => parse(frontmatter), ConfigError);
}

Deno.test("contract ids are read in declaration order", () => {
  assertEquals(
    parse(
      "metadata:\n  contracts:\n    - verdict-format\n    - changelog-entry\n",
    ),
    ["verdict-format", "changelog-entry"],
  );
});

Deno.test("a skill with no metadata block declares nothing", () => {
  assertEquals(parse(""), []);
});

Deno.test("a skill whose metadata holds no contracts key declares nothing", () => {
  assertEquals(parse("metadata:\n  audience: internal\n"), []);
});

Deno.test("a skill with no frontmatter at all declares nothing", () => {
  assertEquals(
    parseContractDeclarations("# Sample\n\nBody.\n", "skills/sample/SKILL.md"),
    [],
  );
});

Deno.test("metadata children indented four spaces still declare their contracts", () => {
  assertEquals(
    parse("metadata:\n    contracts:\n        - verdict-format\n"),
    ["verdict-format"],
  );
});

Deno.test("a trailing comment on a key does not drop the declarations under it", () => {
  assertEquals(
    parse(
      "metadata: # pins live here\n  contracts: # one per line\n    - verdict-format\n",
    ),
    ["verdict-format"],
  );
});

Deno.test("a comment line inside the list does not drop the declarations around it", () => {
  assertEquals(
    parse(
      "metadata:\n  contracts:\n    # the report shape\n    - verdict-format\n",
    ),
    ["verdict-format"],
  );
});

Deno.test("an entry that carries a digest is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - id: verdict-format\n      digest: sha256:" +
      "0".repeat(64) + "\n",
  );
});

Deno.test("declaring the same contract twice is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - verdict-format\n    - verdict-format\n",
  );
});

Deno.test("a flow-style contracts list declares its contracts", () => {
  assertEquals(
    parse("metadata:\n  contracts: [verdict-format, changelog-entry]\n"),
    ["verdict-format", "changelog-entry"],
  );
});

Deno.test("a flow-style metadata mapping declares its contracts", () => {
  assertEquals(parse("metadata: {contracts: [verdict-format]}\n"), [
    "verdict-format",
  ]);
});

Deno.test("list items at the contracts key indent declare their contracts", () => {
  assertEquals(parse("metadata:\n  contracts:\n  - verdict-format\n"), [
    "verdict-format",
  ]);
});

Deno.test("a quoted contract id declares the same contract as a bare one", () => {
  assertEquals(parse('metadata:\n  contracts:\n    - "verdict-format"\n'), [
    "verdict-format",
  ]);
});

Deno.test("a contracts key with no entries under it is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n");
});

Deno.test("an empty contracts list is a configuration error", () => {
  assertRefused("metadata:\n  contracts: []\n");
});

Deno.test("a contracts value that is not a list is a configuration error", () => {
  assertRefused("metadata:\n  contracts: verdict-format\n");
});

Deno.test("an entry that is not a string is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n    - 12\n");
});

Deno.test("an empty entry in the contracts list is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n    -\n");
});

Deno.test("a metadata key that is not a mapping is a configuration error", () => {
  assertRefused("metadata: internal\n");
});

Deno.test("a metadata key with no value at all is a configuration error", () => {
  assertRefused("metadata:\n");
});

Deno.test("frontmatter that is not a mapping is a configuration error", () => {
  assertThrows(
    () =>
      parseContractDeclarations(
        "---\n- verdict-format\n---\n\n# Sample\n",
        "skills/sample/SKILL.md",
      ),
    ConfigError,
  );
});

Deno.test("a metadata key indented under nothing is a configuration error", () => {
  // The shape that was read as "this skill declares nothing" before: the key is
  // indented, so it belongs to no mapping the document opens.
  assertRefused(" metadata:\n   contracts:\n     - verdict-format\n");
});

Deno.test("a tab-indented contracts key is a configuration error", () => {
  // YAML forbids a tab in indentation, but the parser tolerates one and reads
  // the key as a sibling of metadata rather than a child of it. Refusing the
  // tab at the boundary is what keeps that reinterpretation from answering
  // "declares nothing" for a skill that declared something.
  assertRefused(
    "metadata:\n  audience: internal\n\tcontracts:\n\t  - verdict\n",
  );
});

Deno.test("a tab-indented contracts entry is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n\t- verdict-format\n");
});

Deno.test("a delimiter line further down the document opens no second declaration block", () => {
  assertEquals(
    parseContractDeclarations(
      "---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n\n" +
        "---\nmetadata:\n  contracts:\n    - changelog-entry\n---\n",
      "skills/sample/SKILL.md",
    ),
    ["verdict-format"],
  );
});

Deno.test("an unusable contract id in a declaration is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n    - ../escape\n");
});

Deno.test("a second metadata key holding the contracts is a configuration error", () => {
  assertRefused(
    "metadata:\n  audience: internal\nmetadata:\n  contracts:\n    - verdict-format\n",
  );
});

Deno.test("a contracts key indented deeper than its sibling keys is a configuration error", () => {
  assertRefused(
    "metadata:\n  audience: internal\n    contracts:\n      - verdict-format\n",
  );
});

Deno.test("a contracts key indented shallower than its sibling keys is a configuration error", () => {
  assertRefused(
    "metadata:\n    audience: internal\n  contracts:\n    - verdict-format\n",
  );
});

Deno.test("a second contracts key in the same metadata block is a configuration error", () => {
  assertRefused(
    "metadata:\n  contracts:\n    - verdict-format\n  contracts:\n    - changelog-entry\n",
  );
});

Deno.test("frontmatter that cannot be read names the file it came from", () => {
  const error = assertThrows(
    () => parse("metadata:\n  contracts:\n    - a\n  contracts:\n    - b\n"),
    ConfigError,
  );
  assertStringIncludes(error.message, "skills/sample/SKILL.md");
});

Deno.test("frontmatter opened but never closed is a configuration error", () => {
  assertThrows(
    () =>
      parseContractDeclarations(
        "---\nname: sample\nmetadata:\n  contracts:\n    - verdict-format\n",
        "skills/sample/SKILL.md",
      ),
    ConfigError,
  );
});

Deno.test("an opening delimiter carrying a trailing space is a configuration error", () => {
  // Invisible in every editor, survives copy-paste, and tolerated by the
  // frontmatter readers skill authors are used to. Read as "no frontmatter" it
  // would drop the whole block without a word.
  assertThrows(
    () =>
      parseContractDeclarations(
        "--- \nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
        "skills/sample/SKILL.md",
      ),
    ConfigError,
  );
});

Deno.test("an opening delimiter carrying a leading space is a configuration error", () => {
  assertThrows(
    () =>
      parseContractDeclarations(
        " ---\nmetadata:\n  contracts:\n    - verdict-format\n---\n\n# Sample\n",
        "skills/sample/SKILL.md",
      ),
    ConfigError,
  );
});

Deno.test("a document whose lines end with a lone carriage return is a configuration error", () => {
  assertThrows(
    () =>
      parseContractDeclarations(
        "---\rmetadata:\r  contracts:\r    - verdict-format\r---\r\r# Sample\r",
        "skills/sample/SKILL.md",
      ),
    ConfigError,
  );
});
