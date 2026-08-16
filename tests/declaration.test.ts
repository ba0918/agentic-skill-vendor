import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, parseContractDeclarations } from "../src/vendor.ts";

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

Deno.test("a flow-style contracts list is a configuration error", () => {
  assertRefused("metadata:\n  contracts: [verdict-format, changelog-entry]\n");
});

Deno.test("a flow-style metadata mapping is a configuration error", () => {
  assertRefused("metadata: {contracts: [verdict-format]}\n");
});

Deno.test("a contracts key with no entries under it is a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n");
});

Deno.test("list items at the contracts key indent are a configuration error", () => {
  assertRefused("metadata:\n  contracts:\n  - verdict-format\n");
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
