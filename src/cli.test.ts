import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { runCli } from "./testing.ts";

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

test("the entry point touches no file of its own", () => {
  // Routing only. Anything the entry point did itself would be reachable only
  // by assembling an argument list, which is the one shape no test can drive
  // directly.
  // Every read and write the tool makes goes through walk.ts, and the only
  // other way to reach the file system is the builtin itself. The one sync
  // realpath the entry point does call is boot plumbing: it decides whether
  // this module was the program started, before any command runs.
  const reached = SOURCE.match(/from "(node:fs\/promises|\.\/walk\.ts)"/g);
  expect(
    reached,
    `the entry point reaches ${reached?.join(", ")}`,
  ).toStrictEqual(null);
});

test("--root given an empty path is a usage error", async () => {
  // What an unset shell variable expands to. Reduced to "/" it would point the
  // run at the file system root.
  const result = await runCli(["verify", "--root", ""]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
  expect(result.stderr.join("\n")).toContain("--root");
});
