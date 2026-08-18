import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import {
  parseDeclaration,
  readDeclaration,
  withContractMapping,
  withoutContractMapping,
  withSourceRegistration,
} from "./sources.ts";
import { thrownBy, withEmptyDir } from "./testing.ts";

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
  });
  expect(declaration.contracts["writing-style"]).toStrictEqual({
    source: "local",
    path: "docs/style/writing-style.md",
  });
  expect(declaration.contracts["tdd-contract"]).toStrictEqual({
    source: "workflow",
  });
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

test("a repository written as anything but an owner/repo pair is refused", () => {
  // The value is interpolated into a request URL. A full URL accepted here
  // would let the declaration decide which host the tool talks to.
  for (const repository of [
    "https://github.com/ba0918/agentic-workflow",
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
    expect(error.message).toContain("owner/repo");
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
  });
  expect(parseDeclaration(written).contracts["tdd-contract"]).toStrictEqual({
    source: "workflow",
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
