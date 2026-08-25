import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";
import type { GitObjectFormat } from "./digest.ts";

export type GitFailureStage =
  | "ref resolution"
  | "connection or authentication"
  | "commit fetch"
  | "object verification";

export interface GitProcessCommand {
  kind: "external" | "repository";
  args: readonly string[];
  stage: GitFailureStage;
  outputLimit: number;
}

export interface GitProcessSession {
  initialize(objectFormat: GitObjectFormat): Promise<void>;
  run(command: GitProcessCommand): Promise<Uint8Array>;
  stream(
    command: GitProcessCommand,
    take: (chunk: Uint8Array) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface GitProcessRunner {
  begin(options: { interactive: boolean }): Promise<GitProcessSession>;
}

export interface ProcessInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  shell: false;
  detached: true;
  stdin: "inherit" | "ignore";
  stderr: "inherit" | "ignore";
}

export interface RunningProcess {
  stdout: AsyncIterable<Uint8Array>;
  completion: Promise<{ code: number | null }>;
  terminateGroup(): Promise<void>;
}

export interface GitProcessHost {
  now(): number;
  wait(milliseconds: number): Promise<void>;
  createTemporaryDirectory(): Promise<string>;
  removeTemporaryDirectory(path: string): Promise<void>;
  temporaryDirectoryBytes(path: string): Promise<number>;
  environment(): Readonly<Record<string, string>>;
  start(invocation: ProcessInvocation): RunningProcess;
}

export interface GitLimits {
  timeoutMilliseconds: number;
  temporaryBytes: number;
  aggregateBytes: number;
  pollMilliseconds: number;
}

export const DEFAULT_GIT_LIMITS: Readonly<GitLimits> = {
  timeoutMilliseconds: 120_000,
  temporaryBytes: 256 * 1024 * 1024,
  aggregateBytes: 256 * 1024 * 1024,
  pollMilliseconds: 100,
};

const FIXED_CONFIGURATION = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "http.sslVerify=true",
] as const;

const DANGEROUS_ENVIRONMENT = [
  /^GIT_CONFIG_/,
  /^GIT_TRACE/,
  /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/,
  /^GIT_(?:SSH|SSH_COMMAND|PROXY_COMMAND|ASKPASS|EXEC_PATH|EXTERNAL_DIFF)$/,
  /^GIT_HTTP_EXTRA_HEADER$/,
  /^GIT_(?:TERMINAL_PROMPT|SSL_NO_VERIFY|CURL_VERBOSE|HTTP_USER_AGENT)$/,
  /^GIT_PROTOCOL_FROM_USER$/,
  /^GIT_SSH_VARIANT$/,
  /^GIT_ATTR_NOSYSTEM$/,
  /^GIT_CEILING_DIRECTORIES$/,
  /^SSH_ASKPASS(?:_REQUIRE)?$/,
  /^GCM_INTERACTIVE$/,
];

class GitResourceError extends ConfigError {}

export function createGitProcessRunner(
  host: GitProcessHost = nodeGitProcessHost(),
  limits: Readonly<GitLimits> = DEFAULT_GIT_LIMITS,
): GitProcessRunner {
  return {
    async begin({ interactive }) {
      const temporaryDirectory = await host.createTemporaryDirectory();
      return new BoundedGitProcessSession(
        host,
        limits,
        temporaryDirectory,
        interactive,
      );
    },
  };
}

class BoundedGitProcessSession implements GitProcessSession {
  readonly #startedAt: number;
  readonly #host: GitProcessHost;
  readonly #limits: Readonly<GitLimits>;
  readonly #temporaryDirectory: string;
  readonly #interactive: boolean;
  #aggregateBytes = 0;
  #closed = false;

  constructor(
    host: GitProcessHost,
    limits: Readonly<GitLimits>,
    temporaryDirectory: string,
    interactive: boolean,
  ) {
    this.#host = host;
    this.#limits = limits;
    this.#temporaryDirectory = temporaryDirectory;
    this.#interactive = interactive;
    this.#startedAt = host.now();
  }

  async initialize(objectFormat: GitObjectFormat): Promise<void> {
    await this.run({
      kind: "external",
      args: [
        "init",
        "--bare",
        `--object-format=${objectFormat}`,
        `${this.#temporaryDirectory}/repository.git`,
      ],
      stage: "commit fetch",
      outputLimit: 1024 * 1024,
    });
  }

  async run(command: GitProcessCommand): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    await this.stream(command, (chunk) => {
      total += chunk.length;
      const copy = new Uint8Array(chunk.length);
      copy.set(chunk);
      chunks.push(copy);
    });
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async stream(
    command: GitProcessCommand,
    take: (chunk: Uint8Array) => void,
  ): Promise<void> {
    if (this.#closed) throw new ConfigError("Git source session is closed");
    const before = await this.#budgetFailure();
    if (before !== undefined) {
      await this.close().catch(() => {});
      throw before;
    }
    const process = this.#host.start(this.#invocation(command));
    let running = true;
    const monitor = this.#monitor(() => running);
    try {
      let fileBytes = 0;
      const read = (async () => {
        for await (const chunk of process.stdout) {
          fileBytes += chunk.length;
          if (fileBytes > command.outputLimit) {
            throw new GitResourceError(
              `object verification failed: file capacity exceeded ${command.outputLimit} bytes`,
            );
          }
          this.#aggregateBytes += chunk.length;
          if (this.#aggregateBytes > this.#limits.aggregateBytes) {
            throw new GitResourceError(
              `object verification failed: aggregate capacity exceeded ${this.#limits.aggregateBytes} bytes`,
            );
          }
          take(chunk);
        }
      })();
      const completed = process.completion.then((result) => {
        running = false;
        return result;
      });
      const [{ code }] = await Promise.race([
        Promise.all([completed, read]),
        monitor,
      ]);
      if (code !== 0) {
        throw new ConfigError(
          `${command.stage} failed; run Git directly with the same repository URL for details`,
        );
      }
    } catch (cause) {
      running = false;
      await process.terminateGroup().catch(() => {});
      if (cause instanceof GitResourceError) {
        await this.close().catch(() => {});
      }
      if (cause instanceof ConfigError) throw cause;
      throw new ConfigError(
        `${command.stage} failed; external diagnostics were omitted because they may contain credentials`,
      );
    } finally {
      running = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#host.removeTemporaryDirectory(this.#temporaryDirectory);
  }

  #invocation(command: GitProcessCommand): ProcessInvocation {
    const environment = safeEnvironment(
      this.#host.environment(),
      this.#interactive,
    );
    const repositoryArgument =
      command.kind === "repository"
        ? [`--git-dir=${this.#temporaryDirectory}/repository.git`]
        : [];
    return {
      command: "git",
      args: [
        "--no-pager",
        ...FIXED_CONFIGURATION,
        ...repositoryArgument,
        ...command.args,
      ],
      cwd: this.#temporaryDirectory,
      environment,
      shell: false,
      detached: true,
      stdin: this.#interactive ? "inherit" : "ignore",
      stderr: this.#interactive ? "inherit" : "ignore",
    };
  }

  async #monitor(running: () => boolean): Promise<never> {
    while (running()) {
      const failure = await this.#budgetFailure();
      if (failure !== undefined) throw failure;
      await this.#host.wait(this.#limits.pollMilliseconds);
    }
    return await new Promise<never>(() => {});
  }

  async #budgetFailure(): Promise<GitResourceError | undefined> {
    if (this.#host.now() - this.#startedAt > this.#limits.timeoutMilliseconds) {
      return new GitResourceError(
        `timeout exceeded ${this.#limits.timeoutMilliseconds}ms; the Git process group was terminated`,
      );
    }
    if (
      (await this.#host.temporaryDirectoryBytes(this.#temporaryDirectory)) >
      this.#limits.temporaryBytes
    ) {
      return new GitResourceError(
        `temporary repository capacity exceeded ${this.#limits.temporaryBytes} bytes; the Git process group was terminated`,
      );
    }
    return undefined;
  }
}

function safeEnvironment(
  inherited: Readonly<Record<string, string>>,
  interactive: boolean,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (DANGEROUS_ENVIRONMENT.some((pattern) => pattern.test(name))) continue;
    safe[name] = value;
  }
  if (!interactive) {
    safe.GIT_TERMINAL_PROMPT = "0";
    safe.GCM_INTERACTIVE = "never";
    safe.SSH_ASKPASS_REQUIRE = "never";
  }
  return safe;
}

function nodeGitProcessHost(): GitProcessHost {
  return {
    now: () => Date.now(),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    createTemporaryDirectory: async () =>
      await fs.mkdtemp(join(tmpdir(), "agentic-skill-git-")),
    removeTemporaryDirectory: async (path) => {
      await fs.rm(path, { recursive: true, force: true });
    },
    temporaryDirectoryBytes: directoryBytes,
    environment: () => {
      const inherited: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) inherited[name] = value;
      }
      return inherited;
    },
    start(invocation) {
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.environment,
        shell: invocation.shell,
        detached: invocation.detached,
        stdio: [invocation.stdin, "pipe", invocation.stderr],
      });
      const completion = new Promise<{ code: number | null }>((resolve) => {
        child.once("error", () => resolve({ code: null }));
        child.once("close", (code) => resolve({ code }));
      });
      return {
        stdout: child.stdout ?? emptyChunks(),
        completion,
        async terminateGroup() {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (child.exitCode !== null) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        },
      };
    },
  };
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const named = join(current, entry.name);
      if (entry.isDirectory()) pending.push(named);
      else if (!entry.isSymbolicLink()) total += (await fs.stat(named)).size;
    }
  }
  return total;
}

async function* emptyChunks(): AsyncIterable<Uint8Array> {}
