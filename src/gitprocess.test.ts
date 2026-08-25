import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import {
  createGitProcessRunner,
  DEFAULT_GIT_LIMITS,
  type GitProcessHost,
  type ProcessInvocation,
  type RunningProcess,
} from "./gitprocess.ts";

const encoder = new TextEncoder();

class FakeHost implements GitProcessHost {
  nowValue = 0;
  diskBytes = 0;
  readonly invocations: ProcessInvocation[] = [];
  readonly outputs: Uint8Array[][] = [];
  readonly exitCodes: number[] = [];
  killed = 0;
  removed: string[] = [];
  neverComplete = false;
  diskBytesAfterWait: number | undefined;

  now(): number {
    return this.nowValue;
  }
  wait(milliseconds: number): Promise<void> {
    this.nowValue += milliseconds;
    if (this.diskBytesAfterWait !== undefined) {
      this.diskBytes = this.diskBytesAfterWait;
    }
    return Promise.resolve();
  }
  createTemporaryDirectory(): Promise<string> {
    return Promise.resolve("/tmp/fake-git-source");
  }
  removeTemporaryDirectory(path: string): Promise<void> {
    this.removed.push(path);
    return Promise.resolve();
  }
  temporaryDirectoryBytes(): Promise<number> {
    return Promise.resolve(this.diskBytes);
  }
  environment(): Readonly<Record<string, string>> {
    return {
      HOME: "/trusted/home",
      PATH: "/trusted/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: secret",
      GIT_SSH_COMMAND: "evil",
      GIT_TRACE: "1",
      GIT_TERMINAL_PROMPT: "1",
      GIT_SSL_NO_VERIFY: "1",
      SSH_AUTH_SOCK: "/trusted/agent",
    };
  }
  start(invocation: ProcessInvocation): RunningProcess {
    this.invocations.push(invocation);
    const chunks = this.outputs.shift() ?? [];
    const code = this.exitCodes.shift() ?? 0;
    return {
      stdout: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
      completion: this.neverComplete
        ? new Promise(() => {})
        : Promise.resolve({ code }),
      terminateGroup: async () => {
        this.killed += 1;
      },
    };
  }
}

test("uses shell-free fixed repository arguments and preserves only trusted configuration inputs", async () => {
  const host = new FakeHost();
  const session = await createGitProcessRunner(host).begin({
    interactive: false,
  });
  await session.initialize("sha256");
  await session.run({
    kind: "repository",
    args: [
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "ssh://git@example.invalid/a.git",
      "main",
    ],
    stage: "commit fetch",
    outputLimit: 1024,
  });
  const fetch = host.invocations.at(-1);
  if (fetch === undefined) throw new Error("expected a Git invocation");
  expect(fetch.command).toBe("git");
  expect(fetch.shell).toBe(false);
  expect(fetch.args).toContain("--git-dir=/tmp/fake-git-source/repository.git");
  expect(fetch.args).toContain("core.hooksPath=/dev/null");
  expect(fetch.args).toContain("http.sslVerify=true");
  expect(fetch.args).not.toContain("checkout");
  expect(fetch.environment.HOME).toBe("/trusted/home");
  expect(fetch.environment.SSH_AUTH_SOCK).toBe("/trusted/agent");
  expect(fetch.environment.GIT_CONFIG_COUNT).toBeUndefined();
  expect(fetch.environment.GIT_CONFIG_KEY_0).toBeUndefined();
  expect(fetch.environment.GIT_CONFIG_VALUE_0).toBeUndefined();
  expect(fetch.environment.GIT_TRACE).toBeUndefined();
  expect(fetch.environment.GIT_SSL_NO_VERIFY).toBeUndefined();
  expect(fetch.environment.GIT_TERMINAL_PROMPT).toBe("0");
});

test("lets an interactive terminal inherit prompts while non-interactive runs cannot wait for input", async () => {
  const interactiveHost = new FakeHost();
  const interactive = await createGitProcessRunner(interactiveHost).begin({
    interactive: true,
  });
  await interactive.run({
    kind: "external",
    args: ["ls-remote", "ssh://example.invalid/a.git", "HEAD"],
    stage: "ref resolution",
    outputLimit: 100,
  });
  expect(interactiveHost.invocations[0].stdin).toBe("inherit");
  expect(interactiveHost.invocations[0].stderr).toBe("inherit");
  expect(
    interactiveHost.invocations[0].environment.GIT_TERMINAL_PROMPT,
  ).toBeUndefined();

  const batchHost = new FakeHost();
  const batch = await createGitProcessRunner(batchHost).begin({
    interactive: false,
  });
  await batch.run({
    kind: "external",
    args: ["ls-remote", "ssh://example.invalid/a.git", "HEAD"],
    stage: "ref resolution",
    outputLimit: 100,
  });
  expect(batchHost.invocations[0].stdin).toBe("ignore");
  expect(batchHost.invocations[0].stderr).toBe("ignore");
  expect(batchHost.invocations[0].environment.GIT_TERMINAL_PROMPT).toBe("0");
});

test("stops streaming before one file is buffered past its cap", async () => {
  const host = new FakeHost();
  host.outputs.push([encoder.encode("1234"), encoder.encode("5678")]);
  const session = await createGitProcessRunner(host).begin({
    interactive: false,
  });
  await expect(
    session.run({
      kind: "external",
      args: ["cat-file"],
      stage: "object verification",
      outputLimit: 6,
    }),
  ).rejects.toThrow("file capacity");
  expect(host.killed).toBe(1);
});

test("applies the aggregate extraction cap across commands", async () => {
  const host = new FakeHost();
  host.outputs.push([encoder.encode("1234")], [encoder.encode("5678")]);
  const session = await createGitProcessRunner(host, {
    ...DEFAULT_GIT_LIMITS,
    aggregateBytes: 6,
  }).begin({ interactive: false });
  await session.run({
    kind: "external",
    args: ["cat-file"],
    stage: "object verification",
    outputLimit: 4,
  });
  await expect(
    session.run({
      kind: "external",
      args: ["cat-file"],
      stage: "object verification",
      outputLimit: 4,
    }),
  ).rejects.toThrow("aggregate capacity");
  expect(host.killed).toBe(1);
});

test("terminates the process group when the cumulative source deadline is exceeded", async () => {
  const host = new FakeHost();
  host.neverComplete = true;
  const session = await createGitProcessRunner(host, {
    ...DEFAULT_GIT_LIMITS,
    timeoutMilliseconds: 5,
    pollMilliseconds: 10,
  }).begin({ interactive: false });
  await expect(
    session.run({
      kind: "external",
      args: ["ls-remote"],
      stage: "ref resolution",
      outputLimit: 10,
    }),
  ).rejects.toThrow("timeout");
  expect(host.killed).toBe(1);
  expect(host.removed).toEqual(["/tmp/fake-git-source"]);
});

test("terminates the process group when the temporary repository exceeds its cap", async () => {
  const host = new FakeHost();
  host.diskBytesAfterWait = 11;
  host.neverComplete = true;
  const session = await createGitProcessRunner(host, {
    ...DEFAULT_GIT_LIMITS,
    temporaryBytes: 10,
  }).begin({ interactive: false });
  await expect(
    session.run({
      kind: "external",
      args: ["ls-remote"],
      stage: "ref resolution",
      outputLimit: 10,
    }),
  ).rejects.toThrow("temporary repository capacity");
  expect(host.killed).toBe(1);
  expect(host.removed).toEqual(["/tmp/fake-git-source"]);
});

test("reports only a safe stage and removes temporary state after child failure", async () => {
  const host = new FakeHost();
  host.exitCodes.push(128);
  const session = await createGitProcessRunner(host).begin({
    interactive: false,
  });
  const error = await session
    .run({
      kind: "external",
      args: ["ls-remote"],
      stage: "connection or authentication",
      outputLimit: 10,
    })
    .catch((cause) => cause);
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toContain("connection or authentication");
  expect(error.message).not.toContain("secret");
  await session.close();
  expect(host.removed).toEqual(["/tmp/fake-git-source"]);
});
