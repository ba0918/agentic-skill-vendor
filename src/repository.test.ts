import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { classifyRepository, sourceNameFromRepository } from "./repository.ts";

test("an owner/repo pair selects the GitHub API transport", () => {
  expect(classifyRepository("ba0918/agentic-workflow")).toStrictEqual({
    kind: "github",
    repository: "ba0918/agentic-workflow",
  });
});

test("allowlisted SSH and HTTPS forms select generic Git without normalization", () => {
  for (const repository of [
    "ssh://git@example.com/group/repository.git",
    "git@example.com:group/repository.git",
    "https://example.com/group/repository.git",
  ]) {
    expect(classifyRepository(repository)).toStrictEqual({
      kind: "git",
      repository,
    });
  }
});

test("credentials, plaintext and non-network repository forms are refused", () => {
  for (const repository of [
    "https://user@example.com/group/repository.git",
    "https://example.com:secret@example.net/group/repository.git",
    "http://example.com/group/repository.git",
    "file:///tmp/repository.git",
    "git://example.com/group/repository.git",
    "ext::command repository",
    "./repository",
    "../repository",
    "/tmp/repository",
    "-option",
  ]) {
    expect(() => classifyRepository(repository), repository).toThrow(
      ConfigError,
    );
  }
});

test("the default source name is the repository basename without its git suffix", () => {
  for (const repository of [
    "ba0918/repository",
    "ssh://git@example.com/group/repository.git",
    "git@example.com:group/repository.git",
    "https://example.com/group/repository.git",
  ]) {
    expect(sourceNameFromRepository(repository)).toStrictEqual("repository");
  }
});

test("a repository basename that is not a usable source name requires an explicit name", () => {
  expect(() =>
    sourceNameFromRepository("https://example.com/group/Repository.git"),
  ).toThrow(ConfigError);
});
