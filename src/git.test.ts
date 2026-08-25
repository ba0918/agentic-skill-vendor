import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { gitOver } from "./git.ts";
import type {
  GitProcessCommand,
  GitProcessRunner,
  GitProcessSession,
} from "./gitprocess.ts";

const SHA1 = "1".repeat(40);
const SHA1_OTHER = "2".repeat(40);
const SHA256 = "a".repeat(64);
const encoder = new TextEncoder();

class FakeSession implements GitProcessSession {
  readonly calls: Array<GitProcessCommand | { initialize: string }> = [];
  readonly responses = new Map<string, Uint8Array>();
  readonly failures = new Map<string, Error>();
  closed = false;

  initialize(objectFormat: "sha1" | "sha256"): Promise<void> {
    this.calls.push({ initialize: objectFormat });
    return Promise.resolve();
  }

  async run(command: GitProcessCommand): Promise<Uint8Array> {
    this.calls.push(command);
    await Promise.resolve();
    const key = command.args.join("\0");
    const failure = this.failures.get(key);
    if (failure !== undefined) throw failure;
    return this.responses.get(key) ?? new Uint8Array();
  }

  async stream(
    command: GitProcessCommand,
    take: (chunk: Uint8Array) => void,
  ): Promise<void> {
    const bytes = await this.run(command);
    for (let offset = 0; offset < bytes.length; offset += 2) {
      take(bytes.subarray(offset, offset + 2));
    }
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeRunner implements GitProcessRunner {
  readonly sessions: FakeSession[] = [];
  readonly interactive: boolean[] = [];

  begin(options: { interactive: boolean }): Promise<GitProcessSession> {
    this.interactive.push(options.interactive);
    const session = new FakeSession();
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

function answer(
  session: FakeSession,
  args: readonly string[],
  text: string,
): void {
  session.responses.set(args.join("\0"), encoder.encode(text));
}

test("discovers the default branch from the remote HEAD without changing repository state", async () => {
  const runner = new FakeRunner();
  const promise = gitOver(runner, { interactive: false }).defaultBranchOf(
    "ssh://git@example.invalid/group/project.git",
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  answer(
    session,
    [
      "ls-remote",
      "--symref",
      "ssh://git@example.invalid/group/project.git",
      "HEAD",
    ],
    `ref: refs/heads/main\tHEAD\n${SHA1}\tHEAD\n`,
  );
  expect(await promise).toBe("main");
  expect(session.calls).toEqual([
    {
      kind: "external",
      args: [
        "ls-remote",
        "--symref",
        "ssh://git@example.invalid/group/project.git",
        "HEAD",
      ],
      stage: "ref resolution",
      outputLimit: 1024 * 1024,
    },
  ]);
  expect(session.closed).toBe(true);
});

test("fetches a ref shallowly into a bare repository and takes FETCH_HEAD as authority", async () => {
  const runner = new FakeRunner();
  const opening = gitOver(runner, { interactive: true }).open(
    "git@example.invalid:group/project.git",
    { kind: "ref", ref: "main" },
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  answer(
    session,
    ["ls-remote", "git@example.invalid:group/project.git", "main"],
    `${SHA1_OTHER}\trefs/heads/main\n`,
  );
  answer(
    session,
    ["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", "main"],
    "",
  );
  answer(
    session,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    `${SHA1}\n`,
  );
  answer(
    session,
    [
      "ls-tree",
      "-rz",
      "--full-tree",
      "--format=%(objectmode) %(objectname) %(path)",
      SHA1,
    ],
    "",
  );
  const snapshot = await opening;
  expect(snapshot.revision).toBe(SHA1);
  expect(snapshot.objectFormat).toBe("sha1");
  expect(runner.interactive).toEqual([true]);
  expect(session.calls).toContainEqual({ initialize: "sha1" });
  expect(session.calls).toContainEqual({
    kind: "repository",
    args: [
      "remote",
      "add",
      "--no-tags",
      "origin",
      "git@example.invalid:group/project.git",
    ],
    stage: "connection or authentication",
    outputLimit: 1024 * 1024,
  });
  expect(session.calls).toContainEqual({
    kind: "repository",
    args: ["config", "remote.origin.promisor", "true"],
    stage: "connection or authentication",
    outputLimit: 1024 * 1024,
  });
  expect(session.calls).toContainEqual({
    kind: "repository",
    args: ["config", "remote.origin.partialclonefilter", "blob:none"],
    stage: "connection or authentication",
    outputLimit: 1024 * 1024,
  });
  expect(session.calls).toContainEqual({
    kind: "repository",
    args: [
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      "main",
    ],
    stage: "commit fetch",
    outputLimit: 1024 * 1024,
  });
});

test("uses the advertised object-id length to initialize SHA-256 repositories", async () => {
  const runner = new FakeRunner();
  const opening = gitOver(runner, { interactive: false }).open(
    "https://example.invalid/group/project.git",
    { kind: "ref", ref: "main" },
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  answer(
    session,
    ["ls-remote", "https://example.invalid/group/project.git", "main"],
    `${SHA256}\trefs/heads/main\n`,
  );
  answer(
    session,
    ["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", "main"],
    "",
  );
  answer(
    session,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    `${SHA256}\n`,
  );
  answer(
    session,
    [
      "ls-tree",
      "-rz",
      "--full-tree",
      "--format=%(objectmode) %(objectname) %(path)",
      SHA256,
    ],
    "",
  );
  expect((await opening).objectFormat).toBe("sha256");
  expect(session.calls).toContainEqual({ initialize: "sha256" });
});

test("tries an exact pin before the same ref and accepts fallback only on exact equality", async () => {
  const runner = new FakeRunner();
  const opening = gitOver(runner, { interactive: false }).open(
    "ssh://git@example.invalid/group/project.git",
    { kind: "pin", revision: SHA1, objectFormat: "sha1", ref: "main" },
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  const exact = [
    "fetch",
    "--depth=1",
    "--filter=blob:none",
    "--no-tags",
    "origin",
    SHA1,
  ];
  session.failures.set(
    exact.join("\0"),
    new ConfigError("exact pin unavailable"),
  );
  answer(
    session,
    ["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", "main"],
    "",
  );
  answer(
    session,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    `${SHA1}\n`,
  );
  answer(
    session,
    [
      "ls-tree",
      "-rz",
      "--full-tree",
      "--format=%(objectmode) %(objectname) %(path)",
      SHA1,
    ],
    "",
  );
  expect((await opening).revision).toBe(SHA1);
  expect(
    session.calls.findIndex(
      (call) => "args" in call && call.args.at(-1) === SHA1,
    ),
  ).toBeLessThan(
    session.calls.findIndex(
      (call) => "args" in call && call.args.at(-1) === "main",
    ),
  );
});

test("refuses a fallback that fetched a different commit", async () => {
  const runner = new FakeRunner();
  const opening = gitOver(runner, { interactive: false }).open(
    "ssh://git@example.invalid/group/project.git",
    { kind: "pin", revision: SHA1, objectFormat: "sha1", ref: "main" },
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  const exact = [
    "fetch",
    "--depth=1",
    "--filter=blob:none",
    "--no-tags",
    "origin",
    SHA1,
  ];
  session.failures.set(
    exact.join("\0"),
    new ConfigError("exact pin unavailable"),
  );
  answer(
    session,
    ["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", "main"],
    "",
  );
  answer(
    session,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    `${SHA1_OTHER}\n`,
  );
  await expect(opening).rejects.toThrow("different commit");
  expect(session.closed).toBe(true);
});

test("lists SHA-256 blobs and streams one file before returning its bytes", async () => {
  const runner = new FakeRunner();
  const opening = gitOver(runner, { interactive: false }).open(
    "https://example.invalid/group/project.git",
    { kind: "pin", revision: SHA256, objectFormat: "sha256" },
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  answer(
    session,
    ["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", SHA256],
    "",
  );
  answer(
    session,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    `${SHA256}\n`,
  );
  answer(
    session,
    [
      "ls-tree",
      "-rz",
      "--full-tree",
      "--format=%(objectmode) %(objectname) %(path)",
      SHA256,
    ],
    `100644 ${"b".repeat(64)} contracts/a.md\0`,
  );
  answer(session, ["cat-file", "blob", `${SHA256}:contracts/a.md`], "hello");
  const snapshot = await opening;
  expect(snapshot.blobs).toEqual([
    { path: "contracts/a.md", mode: "100644", objectId: "b".repeat(64) },
  ]);
  expect(
    new TextDecoder().decode(await snapshot.fileAt("contracts/a.md")),
  ).toBe("hello");
  expect(session.calls.at(-1)).toEqual({
    kind: "repository",
    args: ["cat-file", "blob", `${SHA256}:contracts/a.md`],
    stage: "object verification",
    outputLimit: 1024 * 1024,
  });
});

test("closes the process session when tree parsing fails", async () => {
  const runner = new FakeRunner();
  const opening = gitOver(runner, { interactive: false }).open(
    "https://example.invalid/group/project.git",
    { kind: "pin", revision: SHA1, objectFormat: "sha1" },
  );
  await Promise.resolve();
  const session = runner.sessions[0];
  answer(
    session,
    ["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", SHA1],
    "",
  );
  answer(
    session,
    ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    `${SHA1}\n`,
  );
  answer(
    session,
    [
      "ls-tree",
      "-rz",
      "--full-tree",
      "--format=%(objectmode) %(objectname) %(path)",
      SHA1,
    ],
    `100644 short contracts/a.md\0`,
  );
  await expect(opening).rejects.toThrow("object id");
  expect(session.closed).toBe(true);
});
