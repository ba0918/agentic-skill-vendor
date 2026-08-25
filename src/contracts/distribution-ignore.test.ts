import { expect, test } from "bun:test";
import { ConfigError } from "../errors.ts";
import { createDistributionIgnore } from "./distribution-ignore.ts";

test("a star excludes matching files below the mapping root", () => {
  const rules = createDistributionIgnore(["*.tmp"], []);
  expect(rules.excludes("nested/result.tmp")).toBe(true);
  expect(rules.excludes("nested/result.ts")).toBe(false);
});

test("a double star spans directory levels", () => {
  const rules = createDistributionIgnore(["docs/**/draft*.md"], []);
  expect(rules.excludes("docs/draft-one.md")).toBe(true);
  expect(rules.excludes("docs/deep/nested/draft-two.md")).toBe(true);
});

test("a leading slash anchors a pattern at the mapping root", () => {
  const rules = createDistributionIgnore(["/root-only.txt"], []);
  expect(rules.excludes("root-only.txt")).toBe(true);
  expect(rules.excludes("nested/root-only.txt")).toBe(false);
});

test("a trailing slash excludes a directory's contents", () => {
  const rules = createDistributionIgnore(["build/"], []);
  expect(rules.excludes("build/output.js")).toBe(true);
  expect(rules.excludes("build.txt")).toBe(false);
});

test("a comment pattern excludes nothing", () => {
  const rules = createDistributionIgnore(["# generated files"], []);
  expect(rules.excludes("# generated files")).toBe(false);
});

test("an escaped comment marker is matched literally", () => {
  const rules = createDistributionIgnore(["\\#notes.txt"], []);
  expect(rules.excludes("#notes.txt")).toBe(true);
});

test("an escaped exclamation mark is matched literally", () => {
  const rules = createDistributionIgnore(["\\!important.txt"], []);
  expect(rules.excludes("!important.txt")).toBe(true);
});

test("an unescaped leading exclamation mark is refused", () => {
  expect(() => createDistributionIgnore(["!keep.txt"], [])).toThrow(
    ConfigError,
  );
  expect(() => createDistributionIgnore([], ["!keep.txt"])).toThrow(
    ConfigError,
  );
});

test("contract exclusions extend shared exclusions", () => {
  const rules = createDistributionIgnore(["*.tmp"], ["private/**"]);
  expect(rules.excludes("result.tmp")).toBe(true);
  expect(rules.excludes("private/result.ts")).toBe(true);
  expect(rules.excludes("public/result.ts")).toBe(false);
});

test("contract exclusions do not leak into another contract", () => {
  const first = createDistributionIgnore([], ["private/**"]);
  const second = createDistributionIgnore([], []);
  expect(first.excludes("private/result.ts")).toBe(true);
  expect(second.excludes("private/result.ts")).toBe(false);
});

test("paths are matched relative to each directory mapping", () => {
  const rules = createDistributionIgnore(["/generated.ts"], []);
  expect(rules.excludes("generated.ts")).toBe(true);
  expect(rules.excludes("other/generated.ts")).toBe(false);
});

test("a pattern that matches no path is accepted", () => {
  const rules = createDistributionIgnore(["missing/**"], []);
  expect(rules.excludes("present/file.ts")).toBe(false);
});
