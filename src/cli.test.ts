import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  importClosureOf,
  fakeGitHub,
  readLockFile,
  remoteSource,
  runCli,
  snapshotTree,
  withFetchedTree,
  withEmptyDir,
  withGoodTree,
} from "./testing.ts";
import { run, startedThisProgram } from "./cli.ts";
import { gitObjectIdOf } from "./digest.ts";
import type { RemoteClient, SnapshotTarget } from "./remote.ts";

const SOURCE = await fs.readFile(new URL("./cli.ts", import.meta.url), "utf8");
const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));

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
    "add",
    "update",
    "fetch",
    "gen",
    "verify",
    "lint-selfcontain",
    "self-test",
  ]) {
    expect(text).toContain(command);
  }
  // The tool has no approval boundary any more, so the help must not go on
  // naming one. The word is absent from the command list and from the wording
  // of what gen does alike: "write the accepted contracts" describes a step
  // the reader would then look for a command to perform.
  expect(text).not.toContain("accept");
});

test("every command the entry point names is answered by a module of its own", () => {
  // Two commands may be answered by one module — update and fetch share the
  // path they end in — so the import list is read as the list of names it is,
  // not as one name per module.
  const imported = new Set(
    [...SOURCE.matchAll(/import \{([^}]+)\} from "\.\/\w+\.ts";/g)].flatMap(
      (match) =>
        match[1].split(",").map((name) => name.trim().replace(/^type /, "")),
    ),
  );
  // The statements a case runs before it delegates — the refusal of an
  // argument the command has no use for — sit between the label and the call.
  // Matched without them, this read only the one case that delegated on the
  // line after its label, so the whole routing table went unchecked but one
  // entry.
  const routed = [
    ...SOURCE.matchAll(
      /case "([\w-]+)":\n(?:\s+\w+\(.*\);\n)*\s+return await (\w+)\(/g,
    ),
  ];
  expect(routed.map(([, command]) => command)).toStrictEqual([
    "add",
    "update",
    "fetch",
    "gen",
    "verify",
    "lint-selfcontain",
    "self-test",
  ]);
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

test("adopting contract text is not a command of its own", async () => {
  // The canonical text is the authority and gen rewrites the lock to match it,
  // so there is nothing left for a separate approval command to do. A run
  // still spelling the old two-step act is refused by name rather than
  // quietly doing nothing.
  const result = await runCli(["accept", "verdict-format"]);
  expect(result.code).toStrictEqual(2);
  expect(result.stdout).toStrictEqual([]);
  expect(result.stderr.join("\n")).toContain("unknown command: accept");
});

test("the entry-point probe answers false when no program is started", () => {
  // A runtime with no `process` global — Deno, which this package claims to
  // support — has no argv entry to name the started program. Reading the
  // global directly throws a ReferenceError on module load there; the probe
  // must answer the same way an absent arg does instead.
  expect(startedThisProgram([])).toStrictEqual(false);
});

test("the entry-point probe answers false for a path it was not started with", () => {
  expect(startedThisProgram(["node", "/no/such/entry"])).toStrictEqual(false);
});

test("the entry-point probe recognizes this program's real path", () => {
  expect(startedThisProgram([process.execPath, CLI_PATH])).toStrictEqual(true);
});

test("the public entry point uses the current directory as its default root", async () => {
  await withGoodTree(async (root) => {
    const child = Bun.spawn([process.execPath, CLI_PATH, "verify"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code, stderr).toStrictEqual(0);
    expect(stdout).toStrictEqual("");
    expect(stderr).toStrictEqual("");
  });
});

test("an unexpected exception is one stderr line on exit code 2", async () => {
  const stderr: string[] = [];
  const code = await run(
    ["--help"],
    () => {
      throw new Error("boom");
    },
    (line) => stderr.push(line),
  );

  expect(code).toStrictEqual(2);
  expect(stderr).toStrictEqual(["internal error: boom"]);
});

test("the commands that work offline reach no network, environment or subprocess", async () => {
  // The boundary the whole design rests on: gen and verify answer from the
  // tree alone, so a repository can run them in continuous integration with no
  // credentials and no host to reach. The transport every test hands the entry
  // point refuses each request, which proves no command asks for one through
  // it; this states the other half — that nothing an offline command is built
  // on reaches past the injection for a global.
  //
  // What each entry point is built on is followed, never listed. A list of
  // module names cannot answer the one question this test exists to ask: an
  // offline command that imported the network layer would add a module the
  // list does not name, so the scan would walk past the very code it was
  // written to catch and report a clean boundary.
  const CONCRETE_REMOTE_MODULES = ["github.ts", "gitprocess.ts"];
  // The probes keep the closure scan and the dynamic adapter boundary honest.
  // Without them, either scan could stop early and still report offline code
  // as isolated.
  const onlineClosure = await importClosureOf("cli.ts");
  expect(onlineClosure.has("github.ts")).toStrictEqual(true);
  const onlineSource = await fs.readFile(
    new URL("./cli.ts", import.meta.url),
    "utf8",
  );
  expect(onlineSource).toContain('import("./git.ts")');
  expect(onlineSource).toContain('import("./gitprocess.ts")');
  expect((await importClosureOf("lint.ts")).has("digest.ts")).toStrictEqual(
    true,
  );
  const resolverClosure = await importClosureOf("resolvecmd.ts");
  for (const name of CONCRETE_REMOTE_MODULES) {
    expect(resolverClosure.has(name), name).toStrictEqual(false);
  }
  for (const entry of ["gen.ts", "verify.ts", "lint.ts", "selftest.ts"]) {
    const closure = await importClosureOf(entry);
    for (const name of CONCRETE_REMOTE_MODULES) {
      expect(closure.has(name), `${entry} -> ${name}`).toStrictEqual(false);
    }
    for (const name of closure) {
      const source = await fs.readFile(
        new URL(`./${name}`, import.meta.url),
        "utf8",
      );
      expect(/\bfetch\s*\(/.test(source), name).toStrictEqual(false);
      expect(source.includes("process.env"), name).toStrictEqual(false);
      expect(source.includes("node:child_process"), name).toStrictEqual(false);
    }
  }
});

const OFFLINE_COMMANDS = ["gen", "verify", "lint-selfcontain", "self-test"];
const NETWORK_COMMANDS = ["update", "fetch"];

test("--token-stdin is refused by every command that reaches no network", async () => {
  // The flag is a statement about a request, and these four make none. Taken
  // quietly, it would tell a reader that `verify` can be authenticated — and
  // the boundary this tool states, that gen and verify read the tree and
  // nothing else, is the thing that claim quietly contradicts.
  for (const command of OFFLINE_COMMANDS) {
    const result = await runCli([command, "--token-stdin"], undefined, () => {
      throw new Error("standard input was read for an offline command");
    });
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain("--token-stdin");
    expect(result.stderr.join("\n")).toContain(command);
  }
});

test("standard input is not read by a command that was not given the flag", async () => {
  // A command reading standard input it was never asked to read hangs a
  // pipeline that had other plans for the stream. The seam here fails the run
  // if it is touched at all.
  await withGoodTree(async (root) => {
    const result = await runCli(["verify", "--root", root], undefined, () => {
      throw new Error("standard input was read");
    });
    expect(result.code).toStrictEqual(0);
  });
});

test("a token that cannot become a header stops the run before any request", async () => {
  // Judged at the boundary, so a value that could put headers of its own into
  // a request never reaches the transport. The refusing transport below is
  // what says no request was made: reached, it throws something that is not a
  // ConfigError and the exit code would not be 2.
  for (const command of NETWORK_COMMANDS) {
    const result = await runCli(
      [command, "--token-stdin"],
      undefined,
      () => "ghp_first\nX-Injected: yes",
    );
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain("position 10");
    expect(result.stderr.join("\n")).not.toContain("X-Injected");
  }
});

test("an empty standard input is refused rather than sent as a credential", async () => {
  for (const command of NETWORK_COMMANDS) {
    const result = await runCli(
      [command, "--token-stdin"],
      undefined,
      () => "",
    );
    expect(result.code).toStrictEqual(2);
    expect(result.stderr.join("\n")).toContain("nothing on standard input");
  }
});

test("invalid add operands are refused before standard input is read", async () => {
  for (const operands of [[], ["owner/repo", "name", "extra"]]) {
    let reads = 0;
    const result = await runCli(
      ["add", ...operands, "--token-stdin"],
      undefined,
      () => {
        reads += 1;
        return "ghp_TestOnlyCredentialValue";
      },
    );
    expect(result.code).toStrictEqual(2);
    expect(reads).toStrictEqual(0);
  }
});

test("the usage text says which commands the token is for", async () => {
  const result = await runCli(["--help"]);
  const usage = result.stdout.join("\n");
  expect(usage).toContain("--token-stdin");
  expect(usage).toContain("add, update and fetch");
});

test("the usage text accepts every supported repository form", async () => {
  const result = await runCli(["--help"]);
  const usage = result.stdout.join("\n");
  expect(usage).toContain("add <repository> [name]");
  expect(usage).not.toContain("add <owner/repo>");
});

const GENERIC_REPOSITORY =
  "ssh://git@example.invalid/group/shared-contracts.git";
const GENERIC_ID = "generic-contract";
const GENERIC_REVISION_1 = "a".repeat(40);
const GENERIC_REVISION_2 = "b".repeat(40);

function fakeGenericRemote(): {
  client: RemoteClient;
  move(revision: string, text: string): void;
} {
  let head = GENERIC_REVISION_1;
  const texts = new Map([
    [GENERIC_REVISION_1, "# Generic contract\n\nFirst revision.\n"],
  ]);
  const client: RemoteClient = {
    async defaultBranchOf(repository) {
      expect(repository).toBe(GENERIC_REPOSITORY);
      return "main";
    },
    async open(repository, target: SnapshotTarget) {
      expect(repository).toBe(GENERIC_REPOSITORY);
      const revision = target.kind === "ref" ? head : target.revision;
      const text = texts.get(revision);
      if (text === undefined) throw new Error("injected unavailable revision");
      const path = `contracts/${GENERIC_ID}.md`;
      return {
        revision,
        objectFormat: "sha1",
        blobs: [
          {
            path,
            mode: "100644",
            objectId: await gitObjectIdOf(new TextEncoder().encode(text)),
          },
        ],
        async fileAt(requested) {
          if (requested !== path) throw new Error("injected missing file");
          return new TextEncoder().encode(text);
        },
        async close() {},
      };
    },
  };
  return {
    client,
    move(revision, text) {
      head = revision;
      texts.set(revision, text);
    },
  };
}

async function declareGenericContract(root: string): Promise<void> {
  const site = `${root}/skills/release-notes/SKILL.md`;
  await fs.writeFile(
    site,
    (await fs.readFile(site, "utf8")).replace(
      "    - changelog-entry\n",
      `    - changelog-entry\n    - ${GENERIC_ID}\n`,
    ),
  );
}

async function addGenericSource(
  root: string,
  remote: ReturnType<typeof fakeGenericRemote>,
): Promise<void> {
  await declareGenericContract(root);
  const result = await runCli(
    ["add", GENERIC_REPOSITORY, "--root", root],
    undefined,
    undefined,
    async () => remote.client,
  );
  expect(result.code, result.stderr.join("\n")).toBe(0);
}

test("a generic repository URL can be added without an explicit source name", async () => {
  await withGoodTree(async (root) => {
    const remote = fakeGenericRemote();
    await addGenericSource(root, remote);
    expect(await fs.readFile(`${root}/vendor-manifest.yaml`, "utf8")).toContain(
      `  shared-contracts:\n    repository: ${GENERIC_REPOSITORY}`,
    );
    expect((await readLockFile(root)).sources["shared-contracts"]).toEqual({
      repository: GENERIC_REPOSITORY,
      revision: GENERIC_REVISION_1,
    });
  });
});

test("update moves a generic source to the fetched revision", async () => {
  await withGoodTree(async (root) => {
    const remote = fakeGenericRemote();
    await addGenericSource(root, remote);
    remote.move(GENERIC_REVISION_2, "# Generic contract\n\nSecond revision.\n");
    const result = await runCli(
      ["update", "--root", root],
      undefined,
      undefined,
      async () => remote.client,
    );
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(
      (await readLockFile(root)).sources["shared-contracts"].revision,
    ).toBe(GENERIC_REVISION_2);
  });
});

test("fetch restores a generic source at the lock pin", async () => {
  await withGoodTree(async (root) => {
    const remote = fakeGenericRemote();
    await addGenericSource(root, remote);
    await fs.rm(`${root}/.agentic-skill-vendor/cache`, {
      recursive: true,
      force: true,
    });
    const result = await runCli(
      ["fetch", "--root", root],
      undefined,
      undefined,
      async () => remote.client,
    );
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(
      await fs.readFile(
        `${root}/.agentic-skill-vendor/cache/shared-contracts/${GENERIC_REVISION_1}/contracts/${GENERIC_ID}.md`,
        "utf8",
      ),
    ).toBe("# Generic contract\n\nFirst revision.\n");
  });
});

test("a GitHub token is never passed to the generic Git capability", async () => {
  await withGoodTree(async (root) => {
    const remote = fakeGenericRemote();
    await addGenericSource(root, remote);
    let reads = 0;
    const result = await runCli(
      ["update", "--token-stdin", "--root", root],
      undefined,
      () => {
        reads += 1;
        return "test-only-token";
      },
      async (...argumentsPassed) => {
        expect(argumentsPassed).toEqual([]);
        return remote.client;
      },
    );
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(reads).toBe(1);
  });
});

test("a failed generic update leaves durable tree state unchanged", async () => {
  await withGoodTree(async (root) => {
    const remote = fakeGenericRemote();
    await addGenericSource(root, remote);
    const before = await snapshotTree(root);
    remote.move(GENERIC_REVISION_2, "# moved then made unavailable\n");
    const failing: RemoteClient = {
      ...remote.client,
      open: async () => {
        throw new Error("injected acquisition failure");
      },
    };
    const result = await runCli(
      ["update", "--root", root],
      undefined,
      undefined,
      async () => failing,
    );
    expect(result.code).toBe(2);
    expect(await snapshotTree(root)).toEqual(before);
  });
});

test("a failed generic add leaves durable tree state unchanged", async () => {
  await withGoodTree(async (root) => {
    await declareGenericContract(root);
    const before = await snapshotTree(root);
    const remote = fakeGenericRemote();
    const failing: RemoteClient = {
      ...remote.client,
      open: async () => {
        throw new Error("injected acquisition failure");
      },
    };
    const result = await runCli(
      ["add", GENERIC_REPOSITORY, "--root", root],
      undefined,
      undefined,
      async () => failing,
    );
    expect(result.code).toBe(2);
    expect(await snapshotTree(root)).toEqual(before);
  });
});

test("one CLI run routes mixed GitHub and generic sources to their owning clients", async () => {
  await withFetchedTree(async (root) => {
    const generic = fakeGenericRemote();
    const github = fakeGitHub(remoteSource());
    await declareGenericContract(root);
    const result = await runCli(
      ["add", GENERIC_REPOSITORY, "--root", root],
      github.fetch,
      undefined,
      async () => generic.client,
    );
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(github.requested.length).toBeGreaterThan(0);
    expect(Object.keys((await readLockFile(root)).sources).sort()).toEqual([
      "shared-contracts",
      "workflow",
    ]);
  });
});
