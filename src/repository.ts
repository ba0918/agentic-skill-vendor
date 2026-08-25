import { ConfigError } from "./errors.ts";

export type Repository =
  | { kind: "github"; repository: string }
  | { kind: "git"; repository: string };

const GITHUB_REPOSITORY =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCP_REPOSITORY =
  /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9._-]*:[^\s\\:]+(?:\/[^\s\\:]+)*$/;
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SOURCE_NAME_LIMIT = 64;

export function classifyRepository(repository: string): Repository {
  if (GITHUB_REPOSITORY.test(repository)) {
    return { kind: "github", repository };
  }
  if (SCP_REPOSITORY.test(repository)) {
    return { kind: "git", repository };
  }
  if (repository.startsWith("ssh://") || repository.startsWith("https://")) {
    const parsed = parseAllowedUrl(repository);
    if (parsed.protocol === "https:" && (parsed.username || parsed.password)) {
      throw invalidRepository(repository);
    }
    if (parsed.protocol === "ssh:" && parsed.password) {
      throw invalidRepository(repository);
    }
    return { kind: "git", repository };
  }
  throw invalidRepository(repository);
}

export function sourceNameFromRepository(repository: string): string {
  const classified = classifyRepository(repository);
  const path =
    classified.kind === "github"
      ? repository.split("/")[1]
      : repository.startsWith("ssh://") || repository.startsWith("https://")
        ? (new URL(repository).pathname.split("/").at(-1) ?? "")
        : (repository
            .slice(repository.indexOf(":") + 1)
            .split("/")
            .at(-1) ?? "");
  const name = path.endsWith(".git") ? path.slice(0, -4) : path;
  assertUsableSourceName(name, "the repository-derived source name");
  return name;
}

export function assertUsableSourceName(name: string, site: string): void {
  if (
    name === "local" ||
    name.length > SOURCE_NAME_LIMIT ||
    name.includes("..") ||
    !SOURCE_NAME.test(name)
  ) {
    throw new ConfigError(
      `${site} is not usable: ${JSON.stringify(name)}; provide an explicit source name`,
    );
  }
}

function parseAllowedUrl(repository: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(repository);
  } catch {
    throw invalidRepository(repository);
  }
  if (
    parsed.hostname === "" ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    repository.includes("%") ||
    /[\s\\]/.test(repository)
  ) {
    throw invalidRepository(repository);
  }
  return parsed;
}

function invalidRepository(repository: string): ConfigError {
  return new ConfigError(
    `repository must be an owner/repo pair or an allowlisted SSH or HTTPS URL, found ${JSON.stringify(repository)}`,
  );
}
