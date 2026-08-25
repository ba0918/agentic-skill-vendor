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
  "src/contracts/conformance.test.ts",
  "src/contracts/conformance.ts",
  "src/contracts/declaration.test.ts",
  "src/contracts/declaration.ts",
  "src/contracts/digest.test.ts",
  "src/contracts/digest.ts",
  "src/contracts/distribution-ignore.test.ts",
  "src/contracts/distribution-ignore.ts",
  "src/contracts/manifest.test.ts",
  "src/contracts/manifest.ts",
  "src/contracts/placement-ownership.test.ts",
  "src/contracts/placement-ownership.ts",
  "src/contracts/raw.ts",
  "src/contracts/repository.test.ts",
  "src/contracts/repository.ts",
  "src/contracts/sources.test.ts",
  "src/contracts/sources.ts",
  "src/errors.ts",
  "src/distribution/gen.test.ts",
  "src/distribution/gen.ts",
  "src/distribution/header.ts",
  "src/distribution/lint.test.ts",
  "src/distribution/lint.ts",
  "src/distribution/placements.test.ts",
  "src/distribution/placements.ts",
  "src/distribution/rawsource.test.ts",
  "src/distribution/rawsource.ts",
  "src/distribution/staging.test.ts",
  "src/distribution/staging.ts",
  "src/distribution/verify.test.ts",
  "src/distribution/verify.ts",
  "src/git.test.ts",
  "src/git.ts",
  "src/github.test.ts",
  "src/github.ts",
  "src/gitprocess.test.ts",
  "src/gitprocess.ts",
  "src/filesystem/ignore.test.ts",
  "src/filesystem/ignore.ts",
  "src/filesystem/walk.test.ts",
  "src/filesystem/walk.ts",
  "src/records.test.ts",
  "src/records.ts",
  "src/remote.ts",
  "src/resolvecmd.test.ts",
  "src/resolvecmd.ts",
  "src/selftest.test.ts",
  "src/selftest.ts",
  "src/test-support/source-layout.test.ts",
  "src/test-support/testing.test.ts",
  "src/test-support/testing.ts",
  "src/token.test.ts",
  "src/token.ts",
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

type Feature =
  | "contracts"
  | "distribution"
  | "filesystem"
  | "remote"
  | "root"
  | "unplaced";

const CONTRACT_MODULES = new Set([
  "conformance.ts",
  "declaration.ts",
  "digest.ts",
  "distribution-ignore.ts",
  "manifest.ts",
  "placement-ownership.ts",
  "raw.ts",
  "repository.ts",
  "sources.ts",
]);

const DISTRIBUTION_MODULES = new Set([
  "gen.ts",
  "header.ts",
  "lint.ts",
  "placements.ts",
  "rawsource.ts",
  "staging.ts",
  "verify.ts",
]);

function featureOf(path: string): Feature {
  const directory = path.split("/")[1];
  if (
    directory === "filesystem" ||
    directory === "contracts" ||
    directory === "distribution"
  ) {
    return directory;
  }
  if (path === "src/errors.ts" || path === "src/records.ts") return "root";
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "walk.ts" || name === "ignore.ts") return "filesystem";
  if (CONTRACT_MODULES.has(name)) return "contracts";
  if (DISTRIBUTION_MODULES.has(name)) return "distribution";
  if (name === "cache.ts") return "remote";
  return "unplaced";
}

function isProduction(path: string): boolean {
  return !path.endsWith(".test.ts") && !path.startsWith("src/test-support/");
}

function filesystemEdgeIsAllowed(importer: string, imported: string): boolean {
  const importedFeature = featureOf(imported);
  if (importedFeature === "filesystem" || importedFeature === "root")
    return true;
  const finalImported =
    imported === "src/digest.ts" ? "src/contracts/digest.ts" : imported;
  return new Set([
    "src/filesystem/walk.ts -> src/contracts/digest.ts",
    "src/filesystem/ignore.ts -> src/contracts/digest.ts",
  ]).has(`${importer} -> ${finalImported}`);
}

function filesystemBoundaryViolations(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (!isProduction(importer) || featureOf(importer) !== "filesystem")
      continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      if (!filesystemEdgeIsAllowed(importer, imported)) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }
  return violations.sort();
}

function rootPrimitiveEdges(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (featureOf(importer) !== "root") continue;
    for (const specifier of relativeImports(source)) {
      violations.push(`${importer} -> ${importedPath(importer, specifier)}`);
    }
  }
  return violations.sort();
}

function contractsBoundaryViolations(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (!isProduction(importer) || featureOf(importer) !== "contracts")
      continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      const importedFeature = featureOf(imported);
      if (
        importedFeature !== "contracts" &&
        importedFeature !== "filesystem" &&
        importedFeature !== "root"
      ) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }
  return violations.sort();
}

function distributionEdgeIsAllowed(
  importer: string,
  imported: string,
): boolean {
  const importedFeature = featureOf(imported);
  if (
    importedFeature === "distribution" ||
    importedFeature === "contracts" ||
    importedFeature === "filesystem" ||
    importedFeature === "root"
  ) {
    return true;
  }
  const finalImported =
    imported === "src/cache.ts" ? "src/remote/cache.ts" : imported;
  return new Set([
    "src/distribution/gen.ts -> src/remote/cache.ts",
    "src/distribution/placements.ts -> src/remote/cache.ts",
  ]).has(`${importer} -> ${finalImported}`);
}

function distributionBoundaryViolations(
  sources: Map<string, string>,
): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (!isProduction(importer) || featureOf(importer) !== "distribution")
      continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      if (!distributionEdgeIsAllowed(importer, imported)) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }
  return violations.sort();
}

async function repositorySources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const path of await sourceFiles()) {
    sources.set(path, await fs.readFile(`${ROOT}/${path}`, "utf8"));
  }
  return sources;
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
  expect(productionTestSupportEdges(await repositorySources())).toStrictEqual(
    [],
  );
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

test("filesystem imports stay within their allowlist and exact temporary exception", async () => {
  expect(filesystemBoundaryViolations(await repositorySources())).toStrictEqual(
    [],
  );
});

test("an unapproved filesystem edge names both paths", () => {
  const sources = new Map([
    ["src/filesystem/walk.ts", 'import "../remote/cache.ts";'],
  ]);
  expect(filesystemBoundaryViolations(sources)).toStrictEqual([
    "src/filesystem/walk.ts -> src/remote/cache.ts",
  ]);
});

test("a similar filesystem path does not inherit a temporary exception", () => {
  const sources = new Map([
    ["src/filesystem/nested/walk.ts", 'import "../../contracts/digest.ts";'],
  ]);
  expect(filesystemBoundaryViolations(sources)).toStrictEqual([
    "src/filesystem/nested/walk.ts -> src/contracts/digest.ts",
  ]);
});

test("root primitives import no internal feature", async () => {
  expect(rootPrimitiveEdges(await repositorySources())).toStrictEqual([]);
});

test("contract imports stay within contracts, filesystem, and root", async () => {
  expect(contractsBoundaryViolations(await repositorySources())).toStrictEqual(
    [],
  );
});

test("a contract import of a higher feature names both paths", () => {
  const sources = new Map([
    ["src/contracts/digest.ts", 'import "../remote/cache.ts";'],
  ]);
  expect(contractsBoundaryViolations(sources)).toStrictEqual([
    "src/contracts/digest.ts -> src/remote/cache.ts",
  ]);
});

test("distribution imports stay within their allowlist and exact cache exceptions", async () => {
  expect(
    distributionBoundaryViolations(await repositorySources()),
  ).toStrictEqual([]);
});

test("an unapproved distribution edge names both paths", () => {
  const sources = new Map([
    ["src/distribution/verify.ts", 'import "../remote/cache.ts";'],
  ]);
  expect(distributionBoundaryViolations(sources)).toStrictEqual([
    "src/distribution/verify.ts -> src/remote/cache.ts",
  ]);
});

test("a similar distribution path does not inherit a cache exception", () => {
  const sources = new Map([
    ["src/distribution/nested/gen.ts", 'import "../../remote/cache.ts";'],
  ]);
  expect(distributionBoundaryViolations(sources)).toStrictEqual([
    "src/distribution/nested/gen.ts -> src/remote/cache.ts",
  ]);
});
