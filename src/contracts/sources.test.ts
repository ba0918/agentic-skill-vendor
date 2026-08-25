import { expect, test } from "bun:test";
import { ConfigError } from "../errors.ts";
import { parseDeclaration, readDeclaration } from "./source-schema.ts";
import {
  withContractMapping,
  withoutContractMapping,
  withSourceRegistration,
} from "./source-edit.ts";
import { thrownBy, withEmptyDir } from "../test-support/testing.ts";

test("a declaration is read as the sources it registers and the origin of each contract", () => {
  const declaration = parseDeclaration(
    [
      "sources:",
      "  workflow:",
      "    repository: ba0918/agentic-workflow",
      "    ref: main",
      "",
      "contracts:",
      "  report-format:",
      "    source: local",
      "  writing-style:",
      "    source: local",
      "    path: docs/style/writing-style.md",
      "  tdd-contract:",
      "    source: workflow",
      "",
    ].join("\n"),
  );
  expect(declaration.sources["workflow"]).toStrictEqual({
    repository: "ba0918/agentic-workflow",
    ref: "main",
  });
  expect(declaration.contracts["report-format"]).toStrictEqual({
    source: "local",
    ignore: [],
  });
  expect(declaration.contracts["writing-style"]).toStrictEqual({
    source: "local",
    path: "docs/style/writing-style.md",
    ignore: [],
  });
  expect(declaration.contracts["tdd-contract"]).toStrictEqual({
    source: "workflow",
    ignore: [],
  });
  expect(declaration.ignore).toStrictEqual([]);
});

test("a declaration keeps shared and contract-specific distribution exclusions", () => {
  const declaration = parseDeclaration(
    [
      "ignore:",
      "  - '**/*.test.ts'",
      "contracts:",
      "  executable:",
      "    source: local",
      "    ignore:",
      "      - '*.tmp'",
      "",
    ].join("\n"),
  );
  expect(declaration.ignore).toStrictEqual(["**/*.test.ts"]);
  expect(declaration.contracts["executable"].ignore).toStrictEqual(["*.tmp"]);
});

test("distribution exclusions must be arrays", () => {
  for (const text of [
    ["ignore: '*.tmp'", ""].join("\n"),
    [
      "contracts:",
      "  executable:",
      "    source: local",
      "    ignore: '*.tmp'",
      "",
    ].join("\n"),
  ]) {
    expect(() => parseDeclaration(text)).toThrow(ConfigError);
  }
});

test("every distribution exclusion must be text", () => {
  for (const text of [
    ["ignore:", "  - 42", ""].join("\n"),
    [
      "contracts:",
      "  executable:",
      "    source: local",
      "    ignore:",
      "      - false",
      "",
    ].join("\n"),
  ]) {
    expect(() => parseDeclaration(text)).toThrow(ConfigError);
  }
});

test("an exclusion cannot re-include a path", () => {
  for (const text of [
    ["ignore:", "  - '!keep.ts'", ""].join("\n"),
    [
      "contracts:",
      "  executable:",
      "    source: local",
      "    ignore:",
      "      - '!keep.ts'",
      "",
    ].join("\n"),
  ]) {
    const error = thrownBy(() => parseDeclaration(text), ConfigError);
    expect(error.message).toContain("!keep.ts");
  }
});

test("an escaped leading exclamation mark is a literal exclusion", () => {
  const declaration = parseDeclaration(
    [
      "ignore:",
      "  - '\\!shared.txt'",
      "contracts:",
      "  executable:",
      "    source: local",
      "    ignore:",
      "      - '\\!private.txt'",
      "",
    ].join("\n"),
  );
  expect(declaration.ignore).toStrictEqual(["\\!shared.txt"]);
  expect(declaration.contracts["executable"].ignore).toStrictEqual([
    "\\!private.txt",
  ]);
});

test("a tree with no declaration file maps nothing and registers nothing", async () => {
  // The state every repository that has never fetched anything is in. Read as
  // a refusal, the tool would stop on trees it used to run over unchanged.
  await withEmptyDir(async (root) => {
    const declaration = await readDeclaration(root);
    expect(declaration.sources).toStrictEqual({});
    expect(declaration.contracts).toStrictEqual({});
  });
});

test("a contract mapped to a source nothing registers is refused", () => {
  // Read as anything but a refusal, the run would go looking for the text in a
  // repository the tree never named — or, worse, decide the mapping is local
  // and report the contract as a closure gap the author cannot act on.
  const error = thrownBy(
    () =>
      parseDeclaration(
        ["contracts:", "  tdd-contract:", "    source: workflow", ""].join(
          "\n",
        ),
      ),
    ConfigError,
  );
  expect(error.message).toContain("workflow");
});

test("a source registered under the name reserved for this repository is refused", () => {
  // `source: local` has to keep one reading. Registered as a repository name,
  // every local mapping in the table would become a question the reader cannot
  // answer by eye.
  const error = thrownBy(
    () =>
      parseDeclaration(
        [
          "sources:",
          "  local:",
          "    repository: ba0918/agentic-workflow",
          "    ref: main",
          "",
        ].join("\n"),
      ),
    ConfigError,
  );
  expect(error.message).toContain("local");
});

test("a source name that could not be a directory of its own is refused", () => {
  // The name becomes a path segment under the cache directory. Anything that
  // walks out of it — a separator, a double dot — would have a fetch write
  // wherever the name pointed.
  for (const name of ["../escape", "with space", "UPPER", ".."]) {
    const error = thrownBy(
      () =>
        parseDeclaration(
          [
            "sources:",
            `  ${JSON.stringify(name)}:`,
            "    repository: ba0918/agentic-workflow",
            "    ref: main",
            "",
          ].join("\n"),
        ),
      ConfigError,
    );
    expect(error.message).toContain("source name");
  }
});

test("a repository outside the transport allowlist is refused", () => {
  for (const repository of [
    "http://github.com/ba0918/agentic-workflow",
    "file:///tmp/workflow",
    "ba0918",
    "ba0918/agentic/workflow",
    "../../etc",
  ]) {
    const error = thrownBy(
      () =>
        parseDeclaration(
          [
            "sources:",
            "  workflow:",
            `    repository: ${JSON.stringify(repository)}`,
            "    ref: main",
            "",
          ].join("\n"),
        ),
      ConfigError,
    );
    expect(error.message).toContain("repository");
  }
});

test("a declaration preserves allowlisted generic Git repository forms", () => {
  for (const repository of [
    "ssh://git@example.com/group/workflow.git",
    "git@example.com:group/workflow.git",
    "https://example.com/group/workflow.git",
  ]) {
    const declaration = parseDeclaration(
      [
        "sources:",
        "  workflow:",
        `    repository: ${repository}`,
        "    ref: main",
        "",
      ].join("\n"),
    );
    expect(declaration.sources["workflow"].repository).toStrictEqual(
      repository,
    );
  }
});

test("a declaration refuses repository scalars containing controls", () => {
  for (const repository of [
    "ssh://git@example.com/group/workflow.git\\0",
    "ssh://git@example.com/group/workflow.git\\x1f",
    "ssh://git@example.com/group/workflow.git\\x7f",
  ]) {
    expect(() =>
      parseDeclaration(
        [
          "sources:",
          "  workflow:",
          `    repository: "${repository}"`,
          "    ref: main",
          "",
        ].join("\n"),
      ),
    ).toThrow(ConfigError);
  }
});

test("a ref that could steer the request it is placed in is refused", () => {
  for (const ref of ["../main", "-flag", "main~1", "with space", "main/"]) {
    const error = thrownBy(
      () =>
        parseDeclaration(
          [
            "sources:",
            "  workflow:",
            "    repository: ba0918/agentic-workflow",
            `    ref: ${JSON.stringify(ref)}`,
            "",
          ].join("\n"),
        ),
      ConfigError,
    );
    expect(error.message).toContain("ref");
  }
});

test("a ref naming a branch below a prefix is accepted", () => {
  // A slash is legal in a branch name and a repository's default branch may
  // carry one, so the refusal above cannot be a blanket ban on separators.
  const declaration = parseDeclaration(
    [
      "sources:",
      "  workflow:",
      "    repository: ba0918/agentic-workflow",
      "    ref: release/2.x",
      "",
    ].join("\n"),
  );
  expect(declaration.sources["workflow"].ref).toStrictEqual("release/2.x");
});

test("a path that walks out of the tree it is read against is refused", () => {
  for (const path of [
    "../outside.md",
    "/etc/passwd",
    "docs//style.md",
    "docs/../../style.md",
    "",
  ]) {
    const error = thrownBy(
      () =>
        parseDeclaration(
          [
            "contracts:",
            "  writing-style:",
            "    source: local",
            `    path: ${JSON.stringify(path)}`,
            "",
          ].join("\n"),
        ),
      ConfigError,
    );
    expect(error.message).toContain("path");
  }
});

test("a local path pointing inside a skill or into the tool's own directory is refused", () => {
  // A canonical text under skills/ makes one skill's file the source of
  // another skill's copy, which is the implicit dependency between skills that
  // vendoring exists to remove. A canonical text inside the cache would make a
  // fetched file the authority over what the tree distributes.
  for (const path of [
    "skills/review-writer/SKILL.md",
    ".agentic-skill-vendor/cache/workflow/abc/contracts/tdd-contract.md",
  ]) {
    const error = thrownBy(
      () =>
        parseDeclaration(
          [
            "contracts:",
            "  writing-style:",
            "    source: local",
            `    path: ${JSON.stringify(path)}`,
            "",
          ].join("\n"),
        ),
      ConfigError,
    );
    expect(error.message).toContain("writing-style");
  }
});

test("a contract mapped twice in one table is refused", () => {
  // One contract, one origin. Two entries under the same id would have the
  // reader and the tool disagree about which of them the run obeyed.
  expect(() =>
    parseDeclaration(
      [
        "contracts:",
        "  tdd-contract:",
        "    source: local",
        "  tdd-contract:",
        "    source: local",
        "    path: docs/tdd.md",
        "",
      ].join("\n"),
    ),
  ).toThrow(ConfigError);
});

const HAND_WRITTEN = [
  "# The sources this repository takes contracts from.",
  "sources:",
  "  workflow:",
  "    repository: ba0918/agentic-workflow",
  "    ref: main",
  "",
  "contracts:",
  "  # Adjudicated by hand: both sources hold this one.",
  "  tdd-contract:",
  "    source: workflow",
  "",
].join("\n");

test("a mapping written into the table leaves every hand-written line where it was", () => {
  // The tool is the scribe of this file, and a person writes the lines no
  // derivation can decide. Rendering the whole document from the parsed shape
  // would settle the argument by deleting the comments that record it.
  const written = withContractMapping(HAND_WRITTEN, "report-format", "local");
  expect(written.split("\n").slice(0, 10)).toStrictEqual(
    HAND_WRITTEN.split("\n").slice(0, 10),
  );
  expect(parseDeclaration(written).contracts["report-format"]).toStrictEqual({
    source: "local",
    ignore: [],
  });
  expect(parseDeclaration(written).contracts["tdd-contract"]).toStrictEqual({
    source: "workflow",
    ignore: [],
  });
});

test("a mapping written into a table that has no contracts block yet opens one", () => {
  const written = withContractMapping(
    [
      "sources:",
      "  workflow:",
      "    repository: ba0918/agentic-workflow",
      "    ref: main",
      "",
    ].join("\n"),
    "tdd-contract",
    "workflow",
  );
  expect(parseDeclaration(written).contracts["tdd-contract"]).toStrictEqual({
    source: "workflow",
    ignore: [],
  });
  expect(parseDeclaration(written).sources["workflow"].ref).toStrictEqual(
    "main",
  );
});

test("a mapping taken out of the table leaves the lines around it untouched", () => {
  // The line is pruned when no skill declares the contract any more. What sits
  // beside it — another entry, the comment adjudicating it — answers for
  // contracts that are still declared.
  const written = withoutContractMapping(HAND_WRITTEN, "tdd-contract");
  expect("tdd-contract" in parseDeclaration(written).contracts).toStrictEqual(
    false,
  );
  expect(written).toContain(
    "  # Adjudicated by hand: both sources hold this one.",
  );
  expect(parseDeclaration(written).sources["workflow"]).toStrictEqual({
    repository: "ba0918/agentic-workflow",
    ref: "main",
  });
});

test("a source registered into a table that has none opens the block", () => {
  const written = withSourceRegistration("", "workflow", {
    repository: "ba0918/agentic-workflow",
    ref: "main",
  });
  expect(parseDeclaration(written).sources["workflow"]).toStrictEqual({
    repository: "ba0918/agentic-workflow",
    ref: "main",
  });
});

test("registering a generic Git source writes its repository unchanged", () => {
  const repository = "git@example.com:group/workflow.git";
  const written = withSourceRegistration("", "workflow", {
    repository,
    ref: "main",
  });
  expect(
    parseDeclaration(written).sources["workflow"].repository,
  ).toStrictEqual(repository);
});

test("a source registered beside an existing one keeps the entries already written", () => {
  const written = withSourceRegistration(HAND_WRITTEN, "meta", {
    repository: "ba0918/agentic-meta",
    ref: "main",
  });
  const declaration = parseDeclaration(written);
  expect(declaration.sources["meta"].repository).toStrictEqual(
    "ba0918/agentic-meta",
  );
  expect(declaration.sources["workflow"].ref).toStrictEqual("main");
  expect(written).toContain(
    "# The sources this repository takes contracts from.",
  );
  expect(declaration.contracts["tdd-contract"]).toStrictEqual({
    source: "workflow",
    ignore: [],
  });
});

test("pruning a mapping never reaches an entry of the same name in another block", () => {
  // A source may be named after the contract it holds. The prune is told an id
  // and nothing else, so a search that ran past the end of the contracts block
  // would take the registration out and leave the mapping standing.
  const table = [
    "contracts:",
    "  report-format:",
    "    source: local",
    "",
    "sources:",
    "  tdd-contract:",
    "    repository: ba0918/agentic-workflow",
    "    ref: main",
    "",
  ].join("\n");
  const written = withoutContractMapping(table, "tdd-contract");
  expect(parseDeclaration(written).sources["tdd-contract"]).toStrictEqual({
    repository: "ba0918/agentic-workflow",
    ref: "main",
  });
});

test("a block written in a form the scribe cannot edit is refused rather than doubled", () => {
  // `contracts: {}` is a legal way to write an empty table, and a scribe that
  // works line by line has nowhere to insert under it. Read as "no block of
  // that name", the run appends a second one — a document carrying the key
  // twice, which this tool's own reader then refuses. The refusal has to come
  // before the write, because after it the file is unreadable to every command.
  const flow = ["sources: {}", "", "contracts: {}", ""].join("\n");

  expect(
    thrownBy(
      () => withContractMapping(flow, "tdd-contract", "local"),
      ConfigError,
    ).message,
  ).toContain("contracts");
  expect(
    thrownBy(
      () =>
        withSourceRegistration(flow, "workflow", {
          repository: "ba0918/agentic-workflow",
          ref: "main",
        }),
      ConfigError,
    ).message,
  ).toContain("sources");
  expect(
    thrownBy(() => withoutContractMapping(flow, "tdd-contract"), ConfigError)
      .message,
  ).toContain("contracts");
});

test("a mapping written below a comment at the left margin is still taken out", () => {
  // A comment carries no indentation in YAML, so one written at the left
  // margin stands inside the block a person wrote it into. Read as the line
  // the block ends before, every entry below it is out of the scribe's reach:
  // the prune leaves the mapping where it was, and the run that asked for it
  // reports a line it never took out.
  const table = [
    "contracts:",
    "  report-format:",
    "    source: local",
    "# tdd-contract is ours as well",
    "  tdd-contract:",
    "    source: local",
    "",
  ].join("\n");

  const written = withoutContractMapping(table, "tdd-contract");

  const declaration = parseDeclaration(written);
  expect("tdd-contract" in declaration.contracts).toStrictEqual(false);
  expect(declaration.contracts["report-format"]).toStrictEqual({
    source: "local",
    ignore: [],
  });
  expect(written).toContain("# tdd-contract is ours as well");
});

test("a mapping written into a table whose lines end CRLF leaves the file uniform", () => {
  // The scribe adds its lines to lines a person's editor wrote. Given LF
  // endings of its own, the file still parses and stops being uniform: the
  // next editor to save it rewrites every line, and the one line this run
  // added is lost in a diff of the whole table.
  const table = [
    "contracts:",
    "  report-format:",
    "    source: local",
    "",
  ].join("\r\n");

  const written = withContractMapping(table, "tdd-contract", "local");

  expect(written).toStrictEqual(
    [
      "contracts:",
      "  report-format:",
      "    source: local",
      "  tdd-contract:",
      "    source: local",
      "",
    ].join("\r\n"),
  );
});

test("registering a source refuses a value the table would not read back as itself", () => {
  // The scribe writes unquoted scalars into a document people also read. A
  // value carrying a line break writes lines of its own — the table below
  // gains a top-level key nobody wrote and still parses — and one opening with
  // a comment character reads as no value at all. Both ends are asked, because
  // they answer different questions: this one is "may this be written", the
  // schema's is "may this be believed".
  const unwritable: [string, { repository: string; ref: string }][] = [
    [
      "workflow",
      { repository: "ba0918/agentic-workflow", ref: "main\nrogue: 1" },
    ],
    ["workflow", { repository: "ba0918/agentic-workflow", ref: "#main" }],
    ["workflow", { repository: "ba0918/agentic-workflow", ref: "" }],
    ["workflow", { repository: "not a repository", ref: "main" }],
    ["work flow", { repository: "ba0918/agentic-workflow", ref: "main" }],
  ];
  for (const [name, record] of unwritable) {
    expect(
      () => withSourceRegistration("", name, record),
      `${name} ${JSON.stringify(record)}`,
    ).toThrow(ConfigError);
  }
});

test("mapping a contract refuses a value the table would not read back as itself", () => {
  const unwritable: [string, string][] = [
    ["tdd-contract", "work flow"],
    ["tdd contract", "workflow"],
    ["tdd-contract", "workflow\nrogue: 1"],
  ];
  for (const [id, source] of unwritable) {
    expect(
      () => withContractMapping("", id, source),
      `${id} ${source}`,
    ).toThrow(ConfigError);
  }
});

test("a table keeps identical dests for different raw contracts", () => {
  const declaration = parseDeclaration(
    [
      "contracts:",
      "  runtime:",
      "    source: local",
      "    files:",
      "      tools/runtime/: scripts/shared/",
      "  helper:",
      "    source: local",
      "    files:",
      "      tools/helper/: scripts/shared/",
      "",
    ].join("\n"),
  );

  expect(declaration.contracts["runtime"].files?.[0].dest).toBe(
    "scripts/shared",
  );
  expect(declaration.contracts["helper"].files?.[0].dest).toBe(
    "scripts/shared",
  );
});

test("a table keeps nested dests for different raw contracts", () => {
  const declaration = parseDeclaration(
    [
      "contracts:",
      "  runtime:",
      "    source: local",
      "    files:",
      "      tools/runtime/: scripts/shared/",
      "  command:",
      "    source: local",
      "    files:",
      "      tools/command/: scripts/shared/bin/",
      "",
    ].join("\n"),
  );

  expect(declaration.contracts["runtime"].files?.[0].dest).toBe(
    "scripts/shared",
  );
  expect(declaration.contracts["command"].files?.[0].dest).toBe(
    "scripts/shared/bin",
  );
});
