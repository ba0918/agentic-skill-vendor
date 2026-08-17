import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { runCli, withEmptyDir, withGoodTree } from "./testing.ts";

const SOURCE = await fs.readFile(new URL("./cli.ts", import.meta.url), "utf8");

test("an unknown command is a usage error", async () => {
  const result = await runCli(["frobnicate"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
  expect(result.stderr.join("\n")).toContain("frobnicate");
});

test("naming no command at all is a usage error", async () => {
  const result = await runCli([]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
});

test("an unknown option is a usage error", async () => {
  const result = await runCli(["verify", "--depth", "2"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
});

test("--root with no path after it is a usage error", async () => {
  const result = await runCli(["verify", "--root"]);
  expect(result.code).toStrictEqual(2);
});

test("asking for help prints the commands and exits cleanly", async () => {
  const result = await runCli(["--help"]);
  expect(result.code).toStrictEqual(0);
  const text = result.stdout.join("\n");
  for (const command of [
    "gen",
    "verify",
    "accept",
    "lint-selfcontain",
    "self-test",
  ]) {
    expect(text).toContain(command);
  }
});

test("every command the entry point names is answered by a module of its own", () => {
  const imported = new Set(
    [...SOURCE.matchAll(/import \{ (\w+) \} from "\.\/(\w+)\.ts";/g)].map(
      (match) => match[1],
    ),
  );
  const routed = [
    ...SOURCE.matchAll(/case "([\w-]+)":\n\s+return await (\w+)\(/g),
  ];
  expect(routed.length > 0, "the entry point routes no command").toStrictEqual(
    true,
  );
  for (const [, command, handler] of routed) {
    expect(
      imported.has(handler),
      `${command} is answered by ${handler}, which no module exports`,
    ).toStrictEqual(true);
  }
});

test("the entry point reaches the file system only to answer whether it was started", () => {
  // Routing only. Anything the entry point did itself would be reachable only
  // by assembling an argument list, which is the one shape no test can drive
  // directly. Every read and write a command makes goes through walk.ts, so
  // naming walk.ts here is as much a violation as naming the builtin.
  //
  // `realpathSync` is the one exception, and it is boot plumbing rather than
  // work: it decides whether this module is the program the runtime started,
  // before any command runs. Listing it by name is what keeps the exception
  // from widening — a second binding on that same import fails this.
  expect(SOURCE).not.toContain('from "./walk.ts"');
  expect(SOURCE.match(/import \* as \w+ from "node:fs[^"]*";/g)).toStrictEqual(
    null,
  );
  const bound = [
    ...SOURCE.matchAll(/import \{([^}]*)\} from "node:fs[^"]*";/g),
  ].flatMap((match) => match[1].split(",").map((name) => name.trim()));
  expect(bound).toStrictEqual(["realpathSync"]);
});

test("a --root path ending in a slash names the same tree as one that does not", async () => {
  // Stated through a message that quotes the path back, because that is the
  // only place the difference between "dir" and "dir/" is visible: the file
  // system reads both the same way, and every path the run reports would
  // otherwise carry a doubled separator from wherever the argument came from.
  await withEmptyDir(async (dir) => {
    const result = await runCli(["lint-selfcontain", "--root", `${dir}/`]);
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toStrictEqual(
      `error: skills/ does not exist under ${dir}`,
    );
  });
});

test("--root followed by another flag is a usage error, not a tree named after it", async () => {
  // What a forgotten path looks like. Swallowed as a directory name it would
  // run against a tree called "--help" and never print the help it was asked
  // for, which is a wrong answer given confidently.
  const result = await runCli(["verify", "--root", "--help"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
  expect(result.stderr.join("\n")).toContain("--root");
});

test("every command that reads a tree refuses a root that is not there", async () => {
  // Answered the same way by each of them. Left to whatever each command opens
  // first, a mistyped path was a usage error under gen and a list of drift
  // under verify: a tree that does not exist reads as one where every file is
  // missing, which is a report about a tree rather than about the mistake.
  for (const command of ["gen", "verify", "lint-selfcontain"]) {
    const result = await runCli([command, "--root", "/no/such/tree"]);
    expect(result.code, command).toStrictEqual(2);
    expect(result.stdout, command).toStrictEqual([]);
    expect(result.stderr.join("\n"), command).toContain(
      "no such tree: /no/such/tree",
    );
  }
  const accepted = await runCli([
    "accept",
    "verdict-format",
    "--root",
    "/no/such/tree",
  ]);
  expect(accepted.code).toStrictEqual(2);
  expect(accepted.stderr.join("\n")).toContain("no such tree: /no/such/tree");
});

test("--root given an empty path is a usage error", async () => {
  // What an unset shell variable expands to. Reduced to "/" it would point the
  // run at the file system root.
  const result = await runCli(["verify", "--root", ""]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
  expect(result.stderr.join("\n")).toContain("--root");
});

test("an argument a command has no use for is a usage error", async () => {
  // Swallowed silently, this is a wrong answer given confidently: the run reads
  // as `verify` against a clean fixture and reports 0, while what was asked —
  // whatever the stray word was meant to name — never happened. It is the
  // shape a mistyped option or a forgotten `--root` leaves behind.
  await withGoodTree(async (root) => {
    for (const command of ["gen", "verify", "lint-selfcontain"]) {
      const result = await runCli([
        command,
        "definitely-not-a-flag",
        "--root",
        root,
      ]);
      expect(result.code, command).toStrictEqual(2);
      expect(result.stdout, command).toStrictEqual([]);
      expect(result.stderr.join("\n"), command).toContain(
        "definitely-not-a-flag",
      );
    }
  });
});

test("self-test refuses an argument as well", async () => {
  const result = await runCli(["self-test", "stray"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
  expect(result.stderr.join("\n")).toContain("stray");
});

test("an unknown command is named as such even when arguments follow it", async () => {
  // Which refusal speaks decides what the reader goes looking for. The command
  // being unknown is why nothing can run, so it is named ahead of anything
  // said about the arguments it was given.
  const result = await runCli(["frobnicate", "stray"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stderr.join("\n")).toContain("unknown command: frobnicate");
});

test("accept still takes the contract ids it is given", async () => {
  await withGoodTree(async (root) => {
    const result = await runCli([
      "accept",
      "verdict-format",
      "changelog-entry",
      "--root",
      root,
    ]);
    expect(result.code, result.stderr.join("\n")).toStrictEqual(0);
    expect(
      result.stdout.filter((line) => line.startsWith("accepted:")),
    ).toStrictEqual(["accepted: verdict-format", "accepted: changelog-entry"]);
  });
});
