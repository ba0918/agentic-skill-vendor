import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";
import type { GitObjectFormat } from "./contracts/digest.ts";

export type GitFailureStage =
  | "ref resolution"
  | "connection or authentication"
  | "commit fetch"
  | "object verification";

export interface GitProcessCommand {
  kind: "external" | "repository";
  args: readonly string[];
  stage: GitFailureStage;
  account?: "metadata" | "extraction";
  outputLimit?: number;
}

export interface GitSourceBudget {
  readonly startedAt: number;
}

interface GitSourceBudgetState {
  elapsedMilliseconds: number;
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
  createBudget(): GitSourceBudget;
  begin(options: {
    interactive: boolean;
    budget?: GitSourceBudget;
  }): Promise<GitProcessSession>;
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
  processGroupId: number | undefined;
  stdout: AsyncIterable<Uint8Array>;
  completion: Promise<{ code: number | null }>;
  terminateGroup(): Promise<void>;
  waitForGroupTermination(): Promise<void>;
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
  /^GIT_(?:COMMON_DIR|TEMPLATE_DIR|SHALLOW_FILE)$/,
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
  const budgetStates = new WeakMap<GitSourceBudget, GitSourceBudgetState>();
  const createBudget = (): GitSourceBudget => ({ startedAt: host.now() });
  return {
    createBudget() {
      const budget = createBudget();
      budgetStates.set(budget, { elapsedMilliseconds: 0 });
      return budget;
    },
    async begin({ budget = createBudget() }) {
      let budgetState = budgetStates.get(budget);
      if (budgetState === undefined) {
        budgetState = { elapsedMilliseconds: 0 };
        budgetStates.set(budget, budgetState);
      }
      const temporaryDirectory = await host.createTemporaryDirectory();
      return new BoundedGitProcessSession(
        host,
        limits,
        temporaryDirectory,
        budgetState,
      );
    },
  };
}

class BoundedGitProcessSession implements GitProcessSession {
  readonly #budget: GitSourceBudgetState;
  readonly #host: GitProcessHost;
  readonly #limits: Readonly<GitLimits>;
  readonly #temporaryDirectory: string;
  #aggregateBytes = 0;
  #cleanupSafe = true;
  #closed = false;
  #terminalFailure: ConfigError | undefined;

  constructor(
    host: GitProcessHost,
    limits: Readonly<GitLimits>,
    temporaryDirectory: string,
    budget: GitSourceBudgetState,
  ) {
    this.#host = host;
    this.#limits = limits;
    this.#temporaryDirectory = temporaryDirectory;
    this.#budget = budget;
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
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
    if (this.#closed) throw new ConfigError("Git source session is closed");
    const before = await this.#budgetFailure();
    if (before !== undefined) {
      await this.close().catch(() => {});
      throw before;
    }
    const commandStartedAt = this.#host.now();
    const process = this.#host.start(this.#invocation(command));
    let running = true;
    const monitor = this.#monitor(() => running, commandStartedAt);
    let read: Promise<void> | undefined;
    try {
      let fileBytes = 0;
      read = (async () => {
        for await (const chunk of process.stdout) {
          fileBytes += chunk.length;
          if (
            command.outputLimit !== undefined &&
            fileBytes > command.outputLimit
          ) {
            throw new GitResourceError(
              `object verification failed: file capacity exceeded ${command.outputLimit} bytes`,
            );
          }
          if (command.account !== "metadata") {
            this.#aggregateBytes += chunk.length;
            if (this.#aggregateBytes > this.#limits.aggregateBytes) {
              throw new GitResourceError(
                `object verification failed: aggregate capacity exceeded ${this.#limits.aggregateBytes} bytes`,
              );
            }
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
      const after = await this.#budgetFailure(commandStartedAt);
      if (after !== undefined) throw after;
      if (code !== 0) {
        throw new ConfigError(
          `${command.stage} failed; run Git directly with the same repository URL for details`,
        );
      }
    } catch (cause) {
      running = false;
      this.#cleanupSafe = false;
      try {
        await process.terminateGroup();
        await process.waitForGroupTermination();
        await Promise.allSettled([read]);
        this.#cleanupSafe = true;
      } catch {
        const retainedDirectory = JSON.stringify(this.#temporaryDirectory);
        this.#terminalFailure = new ConfigError(
          `${command.stage} failed: process group termination could not be confirmed; ` +
            `retained temporary repository: ${retainedDirectory}; ` +
            `detached process group: ${process.processGroupId ?? "unavailable"}; ` +
            `confirm that group has stopped before recursively deleting only ` +
            `this exact directory: ${retainedDirectory}`,
        );
        throw this.#terminalFailure;
      }
      if (cause instanceof GitResourceError) {
        await this.close().catch(() => {});
      }
      if (cause instanceof ConfigError) throw cause;
      throw new ConfigError(
        `${command.stage} failed; external diagnostics were omitted because they may contain credentials`,
      );
    } finally {
      running = false;
      this.#budget.elapsedMilliseconds += Math.max(
        0,
        this.#host.now() - commandStartedAt,
      );
    }
  }

  async close(): Promise<void> {
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
    if (this.#closed) return;
    if (!this.#cleanupSafe) {
      throw new ConfigError(
        "Git process group termination could not be confirmed; temporary repository was retained",
      );
    }
    await this.#host.removeTemporaryDirectory(this.#temporaryDirectory);
    this.#closed = true;
  }

  #invocation(command: GitProcessCommand): ProcessInvocation {
    const environment = safeEnvironment(this.#host.environment());
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
      stdin: "ignore",
      stderr: "ignore",
    };
  }

  async #monitor(
    running: () => boolean,
    commandStartedAt: number,
  ): Promise<never> {
    while (running()) {
      const failure = await this.#budgetFailure(commandStartedAt);
      if (!running()) return await new Promise<never>(() => {});
      if (failure !== undefined) throw failure;
      await this.#host.wait(this.#limits.pollMilliseconds);
    }
    return await new Promise<never>(() => {});
  }

  async #budgetFailure(
    commandStartedAt?: number,
  ): Promise<GitResourceError | undefined> {
    const activeMilliseconds =
      commandStartedAt === undefined
        ? 0
        : Math.max(0, this.#host.now() - commandStartedAt);
    if (
      this.#budget.elapsedMilliseconds + activeMilliseconds >
      this.#limits.timeoutMilliseconds
    ) {
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
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (DANGEROUS_ENVIRONMENT.some((pattern) => pattern.test(name))) continue;
    safe[name] = value;
  }
  safe.GIT_TERMINAL_PROMPT = "0";
  safe.GCM_INTERACTIVE = "never";
  safe.SSH_ASKPASS_REQUIRE = "never";
  safe.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
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
        processGroupId: child.pid,
        stdout: child.stdout ?? emptyChunks(),
        completion,
        async terminateGroup() {
          if (child.pid === undefined) return;
          requireProcessGroupSupport();
          if (!signalProcessGroup(child.pid, "SIGTERM")) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!processGroupExists(child.pid)) return;
          signalProcessGroup(child.pid, "SIGKILL");
        },
        async waitForGroupTermination() {
          if (child.pid === undefined) return;
          requireProcessGroupSupport();
          const deadline = Date.now() + 5_000;
          while (processGroupExists(child.pid)) {
            if (Date.now() >= deadline) {
              throw new Error("process group termination was not observable");
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        },
      };
    },
  };
}

function requireProcessGroupSupport(): void {
  if (process.platform === "win32") {
    throw new Error("process group termination is not observable");
  }
}

function signalProcessGroup(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (cause) {
    if (isNoSuchProcess(cause)) return false;
    throw new Error("process group signaling failed");
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    if (isNoSuchProcess(cause)) return false;
    throw new Error("process group termination is not observable");
  }
}

function isNoSuchProcess(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ESRCH"
  );
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
