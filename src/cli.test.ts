import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./testing.ts";

const SOURCE = await Deno.readTextFile(new URL("./cli.ts", import.meta.url));

Deno.test("an unknown command is a usage error", async () => {
  const result = await runCli(["frobnicate"]);
  assertEquals(result.code, 2);
  assertEquals(result.stdout, []);
  assertStringIncludes(result.stderr.join("\n"), "frobnicate");
});

Deno.test("naming no command at all is a usage error", async () => {
  const result = await runCli([]);
  assertEquals(result.code, 2);
  assertEquals(result.stdout, []);
});

Deno.test("an unknown option is a usage error", async () => {
  const result = await runCli(["verify", "--depth", "2"]);
  assertEquals(result.code, 2);
  assertEquals(result.stdout, []);
});

Deno.test("--root with no path after it is a usage error", async () => {
  const result = await runCli(["verify", "--root"]);
  assertEquals(result.code, 2);
});

Deno.test("asking for help prints the commands and exits cleanly", async () => {
  const result = await runCli(["--help"]);
  assertEquals(result.code, 0);
  const text = result.stdout.join("\n");
  for (
    const command of [
      "gen",
      "verify",
      "accept",
      "lint-selfcontain",
      "self-test",
    ]
  ) {
    assertStringIncludes(text, command);
  }
});

Deno.test("every command the entry point names is answered by a module of its own", () => {
  const imported = new Set(
    [...SOURCE.matchAll(/import \{ (\w+) \} from "\.\/(\w+)\.ts";/g)].map((
      match,
    ) => match[1]),
  );
  const routed = [
    ...SOURCE.matchAll(/case "([\w-]+)":\n\s+return await (\w+)\(/g),
  ];
  assertEquals(routed.length > 0, true, "the entry point routes no command");
  for (const [, command, handler] of routed) {
    assertEquals(
      imported.has(handler),
      true,
      `${command} is answered by ${handler}, which no module exports`,
    );
  }
});

Deno.test("the entry point touches no file of its own", () => {
  // Routing only. Anything the entry point did itself would be reachable only
  // by assembling an argument list, which is the one shape no test can drive
  // directly.
  const reached = SOURCE.match(
    /Deno\.(readFile|readTextFile|writeFile|writeTextFile|readDir|lstat|stat|mkdir|remove|rename|readLink|realPath)\b/g,
  );
  assertEquals(reached, null, `the entry point reaches ${reached?.join(", ")}`);
});

Deno.test("--root given an empty path is a usage error", async () => {
  // What an unset shell variable expands to. Reduced to "/" it would point the
  // run at the file system root.
  const result = await runCli(["verify", "--root", ""]);
  assertEquals(result.code, 2);
  assertEquals(result.stdout, []);
  assertStringIncludes(result.stderr.join("\n"), "--root");
});
