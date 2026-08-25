import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const EXPECTED_SOURCE_FILES = [
  "src/addcmd.test.ts",
  "src/addcmd.ts",
  "src/cache.test.ts",
  "src/cache.ts",
  "src/cli.test.ts",
  "src/cli.ts",
  "src/conformance.test.ts",
  "src/conformance.ts",
  "src/declaration.test.ts",
  "src/declaration.ts",
  "src/digest.test.ts",
  "src/digest.ts",
  "src/distribution-ignore.test.ts",
  "src/distribution-ignore.ts",
  "src/errors.ts",
  "src/gen.test.ts",
  "src/gen.ts",
  "src/git.test.ts",
  "src/git.ts",
  "src/github.test.ts",
  "src/github.ts",
  "src/gitprocess.test.ts",
  "src/gitprocess.ts",
  "src/header.ts",
  "src/ignore.test.ts",
  "src/ignore.ts",
  "src/lint.test.ts",
  "src/lint.ts",
  "src/manifest.test.ts",
  "src/manifest.ts",
  "src/placement-ownership.test.ts",
  "src/placement-ownership.ts",
  "src/placements.test.ts",
  "src/placements.ts",
  "src/raw.ts",
  "src/rawsource.test.ts",
  "src/rawsource.ts",
  "src/records.test.ts",
  "src/records.ts",
  "src/remote.ts",
  "src/repository.test.ts",
  "src/repository.ts",
  "src/resolvecmd.test.ts",
  "src/resolvecmd.ts",
  "src/selftest.test.ts",
  "src/selftest.ts",
  "src/sources.test.ts",
  "src/sources.ts",
  "src/staging.test.ts",
  "src/staging.ts",
  "src/test-support/source-layout.test.ts",
  "src/test-support/testing.test.ts",
  "src/test-support/testing.ts",
  "src/token.test.ts",
  "src/token.ts",
  "src/verify.test.ts",
  "src/verify.ts",
  "src/walk.test.ts",
  "src/walk.ts",
] as const;

async function sourceFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"],
    { cwd: ROOT },
  );
  return stdout
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .sort();
}

function relativeImports(source: string): string[] {
  const imports: string[] = [];
  const pattern =
    /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function importedPath(importer: string, specifier: string): string {
  return posix.normalize(posix.join(dirname(importer), specifier));
}

function productionTestSupportEdges(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (
      importer.endsWith(".test.ts") ||
      importer.startsWith("src/test-support/")
    ) {
      continue;
    }
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      if (imported.startsWith("src/test-support/")) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }
  return violations.sort();
}

test("every source file occupies its frozen migration position", async () => {
  const actual = await sourceFiles();
  const expected: string[] = [...EXPECTED_SOURCE_FILES];
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  expect({ missing, unexpected }).toStrictEqual({
    missing: [],
    unexpected: [],
  });
});

test("production source cannot import test support", async () => {
  const sources = new Map<string, string>();
  for (const path of await sourceFiles()) {
    sources.set(path, await fs.readFile(`${ROOT}/${path}`, "utf8"));
  }
  expect(productionTestSupportEdges(sources)).toStrictEqual([]);
});

test("a production import of test support names both paths", () => {
  const sources = new Map([
    [
      "src/contracts/example.ts",
      'import { fixture } from "../test-support/testing.ts";',
    ],
  ]);
  expect(productionTestSupportEdges(sources)).toStrictEqual([
    "src/contracts/example.ts -> src/test-support/testing.ts",
  ]);
});

test("a side-effect import of test support names both paths", () => {
  const sources = new Map([
    ["src/contracts/example.ts", 'import "../test-support/setup.ts";'],
  ]);
  expect(productionTestSupportEdges(sources)).toStrictEqual([
    "src/contracts/example.ts -> src/test-support/setup.ts",
  ]);
});
