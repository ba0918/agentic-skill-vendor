import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const EXPECTED_SOURCE_FILES = [
  "src/cli.ts",
  "src/cli/run.test.ts",
  "src/cli/run.ts",
  "src/contracts/conformance.test.ts",
  "src/contracts/conformance.ts",
  "src/contracts/cache.ts",
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
  "src/contracts/source-edit.ts",
  "src/contracts/source-schema.ts",
  "src/contracts/sources.test.ts",
  "src/contracts/sources.ts",
  "src/contracts/lock-codec.ts",
  "src/contracts/lock-model.ts",
  "src/diagnostics/selftest.test.ts",
  "src/diagnostics/selftest.ts",
  "src/errors.ts",
  "src/distribution/gen.test.ts",
  "src/distribution/gen.ts",
  "src/distribution/contract-discovery.ts",
  "src/distribution/generation-plan.ts",
  "src/distribution/generation-write.ts",
  "src/distribution/lock-update.ts",
  "src/distribution/tree-materials.ts",
  "src/distribution/header.ts",
  "src/distribution/lint.test.ts",
  "src/distribution/lint.ts",
  "src/distribution/placements.test.ts",
  "src/distribution/placements.ts",
  "src/distribution/placement-plan.ts",
  "src/distribution/placement-verify.ts",
  "src/distribution/raw-contracts.ts",
  "src/distribution/rawsource.test.ts",
  "src/distribution/rawsource.ts",
  "src/distribution/staging.test.ts",
  "src/distribution/staging.ts",
  "src/distribution/verify.test.ts",
  "src/distribution/verify.ts",
  "src/filesystem/ignore.test.ts",
  "src/filesystem/ignore.ts",
  "src/filesystem/atomic-write.ts",
  "src/filesystem/walk.test.ts",
  "src/filesystem/walk.ts",
  "src/filesystem/workdir.ts",
  "src/ordering.test.ts",
  "src/ordering.ts",
  "src/records.test.ts",
  "src/records.ts",
  "src/remote/addcmd.test.ts",
  "src/remote/addcmd.ts",
  "src/remote/cache.test.ts",
  "src/remote/cache.ts",
  "src/remote/git.test.ts",
  "src/remote/git.ts",
  "src/remote/github.test.ts",
  "src/remote/github.ts",
  "src/remote/gitprocess.test.ts",
  "src/remote/gitprocess.ts",
  "src/remote/remote.ts",
  "src/remote/resolvecmd.test.ts",
  "src/remote/resolvecmd.ts",
  "src/remote/cache-write.ts",
  "src/remote/lock-update.ts",
  "src/remote/snapshot-plan.ts",
  "src/remote/source-collection.ts",
  "src/remote/token.test.ts",
  "src/remote/token.ts",
  "src/test-support/source-layout.test.ts",
  "src/test-support/assertions.ts",
  "src/test-support/cli.ts",
  "src/test-support/filesystem.ts",
  "src/test-support/fixtures.ts",
  "src/test-support/imports.ts",
  "src/test-support/remote.ts",
  "src/test-support/filesystem.test.ts",
] as const;

const PHASE2_TARGET_MODULES = [
  "src/ordering.ts",
  "src/contracts/cache.ts",
  "src/contracts/lock-codec.ts",
  "src/contracts/lock-model.ts",
  "src/contracts/source-edit.ts",
  "src/contracts/source-schema.ts",
  "src/distribution/contract-discovery.ts",
  "src/distribution/generation-plan.ts",
  "src/distribution/generation-write.ts",
  "src/distribution/lock-update.ts",
  "src/distribution/placement-plan.ts",
  "src/distribution/placement-verify.ts",
  "src/distribution/raw-contracts.ts",
  "src/distribution/tree-materials.ts",
  "src/filesystem/atomic-write.ts",
  "src/filesystem/workdir.ts",
  "src/remote/cache-write.ts",
  "src/remote/lock-update.ts",
  "src/remote/snapshot-plan.ts",
  "src/remote/source-collection.ts",
  "src/test-support/assertions.ts",
  "src/test-support/cli.ts",
  "src/test-support/filesystem.ts",
  "src/test-support/fixtures.ts",
  "src/test-support/imports.ts",
  "src/test-support/remote.ts",
] as const;

async function sourceFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"],
    { cwd: ROOT },
  );
  const candidates = stdout
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .sort();
  const present = await Promise.all(
    candidates.map(async (path) =>
      fs.stat(`${ROOT}/${path}`).then(
        () => true,
        () => false,
      ),
    ),
  );
  return candidates.filter((_, index) => present[index]);
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
  | "cli"
  | "contracts"
  | "diagnostics"
  | "distribution"
  | "entrypoint"
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

const REMOTE_MODULES = new Set([
  "addcmd.ts",
  "cache.ts",
  "git.ts",
  "github.ts",
  "gitprocess.ts",
  "remote.ts",
  "resolvecmd.ts",
  "token.ts",
]);

const TEMPORARY_FEATURE_EDGES = new Set<string>();

function featureOf(path: string): Feature {
  const directory = path.split("/")[1];
  if (
    directory === "filesystem" ||
    directory === "contracts" ||
    directory === "cli" ||
    directory === "diagnostics" ||
    directory === "distribution" ||
    directory === "remote"
  ) {
    return directory;
  }
  if (path === "src/cli.ts") return "entrypoint";
  if (
    path === "src/errors.ts" ||
    path === "src/ordering.ts" ||
    path === "src/records.ts"
  )
    return "root";
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "walk.ts" || name === "ignore.ts") return "filesystem";
  if (CONTRACT_MODULES.has(name)) return "contracts";
  if (DISTRIBUTION_MODULES.has(name)) return "distribution";
  if (REMOTE_MODULES.has(name)) return "remote";
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
  return TEMPORARY_FEATURE_EDGES.has(`${importer} -> ${finalImported}`);
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
  return TEMPORARY_FEATURE_EDGES.has(`${importer} -> ${finalImported}`);
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

function remoteBoundaryViolations(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (!isProduction(importer) || featureOf(importer) !== "remote") continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      const importedFeature = featureOf(imported);
      if (
        importedFeature !== "remote" &&
        importedFeature !== "distribution" &&
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

function diagnosticsBoundaryViolations(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (!isProduction(importer) || featureOf(importer) !== "diagnostics")
      continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      const importedFeature = featureOf(imported);
      if (
        importedFeature !== "diagnostics" &&
        importedFeature !== "distribution" &&
        importedFeature !== "contracts" &&
        importedFeature !== "root"
      ) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }
  return violations.sort();
}

function entrypointBoundaryViolations(sources: Map<string, string>): string[] {
  const source = sources.get("src/cli.ts");
  if (source === undefined) return [];
  return relativeImports(source)
    .map((specifier) => importedPath("src/cli.ts", specifier))
    .filter(
      (imported) =>
        imported !== "src/cli/run.ts" &&
        imported !== "src/errors.ts" &&
        imported !== "src/records.ts",
    )
    .map((imported) => `src/cli.ts -> ${imported}`)
    .sort();
}

function sourceEscapeEdges(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [importer, source] of sources) {
    if (!isProduction(importer)) continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      if (!imported.startsWith("src/")) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }
  return violations.sort();
}

function featureCycleEdges(sources: Map<string, string>): string[] {
  const edges: Array<{
    importer: string;
    imported: string;
    from: Feature;
    to: Feature;
  }> = [];
  const adjacency = new Map<Feature, Set<Feature>>();
  for (const [importer, source] of sources) {
    if (!isProduction(importer)) continue;
    const from = featureOf(importer);
    if (from === "root" || from === "entrypoint" || from === "unplaced")
      continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      if (TEMPORARY_FEATURE_EDGES.has(`${importer} -> ${imported}`)) {
        continue;
      }
      const to = featureOf(imported);
      if (
        to === from ||
        to === "root" ||
        to === "entrypoint" ||
        to === "unplaced"
      ) {
        continue;
      }
      edges.push({ importer, imported, from, to });
      const next = adjacency.get(from) ?? new Set<Feature>();
      next.add(to);
      adjacency.set(from, next);
    }
  }
  const reaches = (from: Feature, target: Feature): boolean => {
    const pending = [from];
    const seen = new Set<Feature>();
    while (pending.length > 0) {
      const feature = pending.pop() as Feature;
      if (feature === target) return true;
      if (seen.has(feature)) continue;
      seen.add(feature);
      pending.push(...(adjacency.get(feature) ?? []));
    }
    return false;
  };
  return edges
    .filter(({ from, to }) => reaches(to, from))
    .map(({ importer, imported }) => `${importer} -> ${imported}`)
    .sort();
}

function aggregatorIndexFiles(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, source] of sources) {
    if (
      isProduction(path) &&
      path.endsWith("/index.ts") &&
      /^\s*export\s+(?:type\s+)?(?:\*|\{)/m.test(source) &&
      !/\b(?:class|function|interface|const|let|var)\b/.test(source)
    ) {
      violations.push(path);
    }
  }
  return violations.sort();
}

function unknownProductionRoots(paths: Iterable<string>): string[] {
  const allowed = new Set([
    "src/cli.ts",
    "src/errors.ts",
    "src/ordering.ts",
    "src/records.ts",
  ]);
  return [...paths]
    .filter(
      (path) =>
        isProduction(path) &&
        path.startsWith("src/") &&
        !path.slice(4).includes("/") &&
        !allowed.has(path),
    )
    .sort();
}

async function repositorySources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const path of await sourceFiles()) {
    sources.set(path, await fs.readFile(`${ROOT}/${path}`, "utf8"));
  }
  return sources;
}

function testSupportOwnershipViolations(
  sources: Map<string, string>,
): string[] {
  const owners = [
    "assertions.ts",
    "cli.ts",
    "filesystem.ts",
    "fixtures.ts",
    "imports.ts",
    "remote.ts",
  ];
  const violations = owners.filter((name) => {
    const source = sources.get(`src/test-support/${name}`) ?? "";
    return /from ["']\.\/testing\.ts["']/.test(source);
  });
  const legacy = sources.get("src/test-support/testing.ts") ?? "";
  if (/\b(?:function|interface|const|let|var|class)\b/.test(legacy)) {
    violations.push("testing.ts owns an implementation");
  }
  return violations;
}

function lockOwnershipViolations(sources: Map<string, string>): string[] {
  const manifest = sources.get("src/contracts/manifest.ts") ?? "";
  const codec = sources.get("src/contracts/lock-codec.ts") ?? "";
  const model = sources.get("src/contracts/lock-model.ts") ?? "";
  const violations: string[] = [];
  if (/function canonicalJson/.test(manifest))
    violations.push("manifest canonicalJson");
  if (/function buildLock/.test(manifest))
    violations.push("manifest buildLock");
  if (!/function canonicalJson/.test(codec))
    violations.push("codec implementation");
  if (!/function buildLock/.test(model))
    violations.push("model implementation");
  return violations;
}

function treeMaterialOwnershipViolations(
  sources: Map<string, string>,
): string[] {
  const gen = sources.get("src/distribution/gen.ts") ?? "";
  const verify = sources.get("src/distribution/verify.ts") ?? "";
  const owner = sources.get("src/distribution/tree-materials.ts") ?? "";
  const violations: string[] = [];
  if (/function readTreeState/.test(gen)) violations.push("gen readTreeState");
  if (!/function prepareTreeMaterials/.test(owner))
    violations.push("missing owner pipeline");
  if (!/prepareTreeMaterials\(/.test(gen))
    violations.push("gen bypasses pipeline");
  if (!/prepareTreeMaterials\(/.test(verify))
    violations.push("verify bypasses pipeline");
  return violations;
}

function sameDirectoryCycleEdges(sources: Map<string, string>): string[] {
  const adjacency = new Map<string, Set<string>>();
  for (const [importer, source] of sources) {
    if (!isProduction(importer)) continue;
    const directory = dirname(importer);
    if (directory !== "src/distribution") continue;
    for (const specifier of relativeImports(source)) {
      const imported = importedPath(importer, specifier);
      if (dirname(imported) !== directory || !sources.has(imported)) continue;
      const edges = adjacency.get(importer) ?? new Set<string>();
      edges.add(imported);
      adjacency.set(importer, edges);
    }
  }
  const reaches = (from: string, target: string): boolean => {
    const pending = [from];
    const seen = new Set<string>();
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      pending.push(...(adjacency.get(node) ?? []));
    }
    return false;
  };
  return [...adjacency]
    .flatMap(([from, tos]) =>
      [...tos]
        .filter((to) => reaches(to, from))
        .map((to) => `${from} -> ${to}`),
    )
    .sort();
}

function discoveryOwnershipViolations(sources: Map<string, string>): string[] {
  const old = sources.get("src/distribution/gen.ts") ?? "";
  const owner = sources.get("src/distribution/contract-discovery.ts") ?? "";
  const names = [
    "vendorDirOf",
    "readContracts",
    "locateContracts",
    "listVendorEntries",
  ];
  return names.flatMap((name) => {
    const violations: string[] = [];
    if (new RegExp(`function ${name}`).test(old))
      violations.push(`gen ${name}`);
    if (!new RegExp(`function ${name}`).test(owner))
      violations.push(`owner ${name}`);
    return violations;
  });
}

function sourceOwnershipViolations(sources: Map<string, string>): string[] {
  const model = sources.get("src/contracts/sources.ts") ?? "";
  const schema = sources.get("src/contracts/source-schema.ts") ?? "";
  const edit = sources.get("src/contracts/source-edit.ts") ?? "";
  const violations: string[] = [];
  if (!/interface Declaration/.test(model))
    violations.push("shared source model");
  if (!/function readDeclaration/.test(model))
    violations.push("source read boundary");
  if (/filesystem\/walk\.ts/.test(schema))
    violations.push("schema reaches filesystem");
  if (/interface Declaration/.test(schema))
    violations.push("schema owns model");
  if (!/function parseDeclaration/.test(schema))
    violations.push("schema parser");
  if (!/function withContractMapping/.test(edit))
    violations.push("line editor");
  return violations;
}

function manifestCompatibilityExports(source: string): string[] {
  const violations: string[] = [];
  if (/export \{ buildLock \} from/.test(source)) violations.push("buildLock");
  if (/export \{ canonicalJson \} from/.test(source))
    violations.push("canonicalJson");
  if (
    /export type \{[^}]*\b(?:LockSource|Resolution|Placement)\b/s.test(source)
  ) {
    violations.push("lock model types");
  }
  return violations;
}

function testSupportBarrelViolations(sources: Map<string, string>): string[] {
  const violations: string[] = [];
  if (sources.has("src/test-support/testing.ts"))
    violations.push("testing barrel");
  for (const [path, source] of sources) {
    if (path === "src/test-support/source-layout.test.ts") continue;
    if (/from ["'](?:\.\/|\.\.\/test-support\/)testing\.ts["']/.test(source)) {
      violations.push(path);
    }
  }
  return violations.sort();
}

function remainingOwnerViolations(sources: Map<string, string>): string[] {
  const checks: Array<[string, RegExp, string]> = [
    [
      "src/distribution/placements.ts",
      /function (?:planPlacements|placementViolations|buildPlacementPlan|checkPlacementViolations)/,
      "placements owns extracted logic",
    ],
    [
      "src/distribution/gen.ts",
      /function (?:planExpansion|executePlan|closureViolations|lockViolations|buildExpansionPlan|legacyClosureViolations|legacyLockViolations)/,
      "gen owns extracted logic",
    ],
    [
      "src/contracts/manifest.ts",
      /function (?:validatePlacements|validateSources|validateResolutions|pickObject|requireDigest|legacyValidatePlacements|legacyValidateSources|legacyValidateResolutions|legacyPickObject|legacyRequireDigest)/,
      "manifest owns serialized validation",
    ],
    [
      "src/filesystem/walk.ts",
      /function (?:atomicWriteFile|atomicWriteDirectory|assertReplaceableDirectory|assertWritableTarget)/,
      "walk owns atomic writes",
    ],
    [
      "src/remote/resolvecmd.ts",
      /function (?:updateRequests|fetchRequests|writeLockSources|collectSources|placeInCache|mapDeclaredContracts|resolveSources|requirePinnedSnapshot|collectContract|collectRawMapping|fetchChecked|legacyCollectSources)/,
      "resolvecmd owns extracted logic",
    ],
  ];
  const violations = checks.flatMap(([path, pattern, message]) =>
    pattern.test(sources.get(path) ?? "") ? [message] : [],
  );
  const facades = [
    ["src/distribution/raw-contracts.ts", "placements.ts"],
    ["src/distribution/placement-plan.ts", "placements.ts"],
    ["src/distribution/placement-verify.ts", "placements.ts"],
    ["src/distribution/generation-plan.ts", "gen.ts"],
    ["src/distribution/generation-write.ts", "gen.ts"],
    ["src/distribution/lock-update.ts", "gen.ts"],
    ["src/filesystem/atomic-write.ts", "walk.ts"],
    ["src/remote/snapshot-plan.ts", "resolvecmd.ts"],
    ["src/remote/source-collection.ts", "resolvecmd.ts"],
    ["src/remote/cache-write.ts", "resolvecmd.ts"],
    ["src/remote/lock-update.ts", "resolvecmd.ts"],
  ] as const;
  for (const [path, oldOwner] of facades) {
    if (
      new RegExp(
        `export(?:\\s+type)?\\s+\\{[\\s\\S]*?\\}\\s+from\\s+"\\./${oldOwner.replace(".", "\\.")}"`,
      ).test(sources.get(path) ?? "")
    ) {
      violations.push(`${path} re-exports ${oldOwner}`);
    }
  }
  for (const path of [
    "src/distribution/placement-plan.ts",
    "src/distribution/placement-verify.ts",
  ]) {
    if (
      /\.\.\.args|buildPlacementPlan|checkPlacementViolations/.test(
        sources.get(path) ?? "",
      )
    ) {
      violations.push(`${path} forwards to the old placement owner`);
    }
  }
  const ownerContracts: Array<[string, RegExp, string]> = [
    [
      "src/distribution/raw-contracts.ts",
      /interface RawReading/,
      "raw input model owner",
    ],
    [
      "src/distribution/raw-contracts.ts",
      /function rawMappingsOf/,
      "raw mapping owner",
    ],
    [
      "src/distribution/raw-contracts.ts",
      /function readRawContracts/,
      "raw reader owner",
    ],
    [
      "src/distribution/raw-contracts.ts",
      /function assertKindsAgree/,
      "raw kind validation owner",
    ],
    [
      "src/distribution/placement-plan.ts",
      /function planMigration/,
      "migration plan owner",
    ],
    [
      "src/distribution/placement-plan.ts",
      /function planSweep/,
      "placement sweep owner",
    ],
    [
      "src/distribution/placement-verify.ts",
      /function expectedPlacements/,
      "placement expectation owner",
    ],
    [
      "src/distribution/lock-update.ts",
      /function deriveResolutions/,
      "lock derivation owner",
    ],
    [
      "src/distribution/lock-update.ts",
      /function rewriteReport/,
      "lock rewrite report owner",
    ],
    [
      "src/distribution/lock-update.ts",
      /function unusedReport/,
      "unused resolution report owner",
    ],
    [
      "src/remote/source-collection.ts",
      /function collectSources/,
      "remote source collection owner",
    ],
    [
      "src/remote/source-collection.ts",
      /function mapDeclaredContracts/,
      "remote mapping plan owner",
    ],
    [
      "src/remote/source-collection.ts",
      /function requirePinnedSnapshot/,
      "remote pin validation owner",
    ],
    [
      "src/remote/source-collection.ts",
      /function collectContract/,
      "remote document collection owner",
    ],
    [
      "src/remote/source-collection.ts",
      /function collectRawMapping/,
      "remote raw collection owner",
    ],
    [
      "src/remote/source-collection.ts",
      /function fetchChecked/,
      "remote git object verification owner",
    ],
    [
      "src/remote/cache-write.ts",
      /function placeInCache/,
      "remote verified cache publication owner",
    ],
    [
      "src/remote/lock-update.ts",
      /function resolveSources/,
      "remote pin resolution owner",
    ],
    [
      "src/remote/lock-update.ts",
      /function writeLockSources/,
      "remote lock write owner",
    ],
  ];
  for (const [path, pattern, message] of ownerContracts) {
    if (!pattern.test(sources.get(path) ?? "")) violations.push(message);
  }
  const placements = sources.get("src/distribution/placements.ts") ?? "";
  if (
    /function (?:rawMappingsOf|readRawContracts|deriveRawResolutions|assertKindsAgree|rawLockViolations|planMigration|planSweep|expectedPlacements)/.test(
      placements,
    )
  ) {
    violations.push("placements retains higher-level ownership");
  }
  const gen = sources.get("src/distribution/gen.ts") ?? "";
  if (
    /function (?:deriveResolutions|rewriteReport|unusedReport|rewrittenValues)/.test(
      gen,
    )
  ) {
    violations.push("gen retains lock derivation or reporting");
  }
  if (
    /export \{ closureViolations, lockViolations \}/.test(
      sources.get("src/distribution/generation-plan.ts") ?? "",
    )
  ) {
    violations.push("generation plan re-exports lock diagnostics");
  }
  const remoteOrchestrator = sources.get("src/remote/resolvecmd.ts") ?? "";
  if (/SourceCollectors|sourceCollectors/.test(remoteOrchestrator)) {
    violations.push("resolvecmd wires a source collection callback facade");
  }
  if (
    !/from "\.\/source-collection\.ts"/.test(remoteOrchestrator) ||
    !/\bcollectSources\b/.test(remoteOrchestrator) ||
    !/\bmapDeclaredContracts\b/.test(remoteOrchestrator)
  ) {
    violations.push("resolvecmd bypasses the source collection owner");
  }
  if (
    !/from "\.\/lock-update\.ts"/.test(remoteOrchestrator) ||
    !/\bresolveSources\b/.test(remoteOrchestrator) ||
    !/\bwriteLockSources\b/.test(remoteOrchestrator)
  ) {
    violations.push("resolvecmd bypasses the remote lock owner");
  }
  if (
    !/from "\.\/cache-write\.ts"/.test(remoteOrchestrator) ||
    !/\bplaceInCache\b/.test(remoteOrchestrator)
  ) {
    violations.push("resolvecmd bypasses verified cache publication");
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

test("test support responsibilities have one final owner", async () => {
  expect(
    testSupportOwnershipViolations(await repositorySources()),
  ).toStrictEqual([]);
});

test("lock model and codec responsibilities have one final owner", async () => {
  expect(lockOwnershipViolations(await repositorySources())).toStrictEqual([]);
});

test("gen and verify share one tree-material preparation owner", async () => {
  expect(
    treeMaterialOwnershipViolations(await repositorySources()),
  ).toStrictEqual([]);
});

test("contract discovery owns discovery without a same-directory module cycle", async () => {
  const sources = await repositorySources();
  expect(discoveryOwnershipViolations(sources)).toStrictEqual([]);
  expect(sameDirectoryCycleEdges(sources)).toStrictEqual([]);
});

test("source schema and line editing have final owners", async () => {
  expect(sourceOwnershipViolations(await repositorySources())).toStrictEqual(
    [],
  );
});

test("manifest exports only its filesystem and top-level lock boundary", async () => {
  const source =
    (await repositorySources()).get("src/contracts/manifest.ts") ?? "";
  expect(manifestCompatibilityExports(source)).toStrictEqual([]);
});

test("test helpers have no compatibility barrel or callers", async () => {
  expect(testSupportBarrelViolations(await repositorySources())).toStrictEqual(
    [],
  );
});

test("remaining Phase 2 modules own their implementations", async () => {
  const sources = await repositorySources();
  expect(remainingOwnerViolations(sources)).toStrictEqual([]);
  expect(sameDirectoryCycleEdges(sources)).toStrictEqual([]);
});

test("the Phase 2 target inventory and final feature edges are complete", async () => {
  if (process.env.PHASE2_TARGET !== "1") return;
  const actual = await sourceFiles();
  expect(
    PHASE2_TARGET_MODULES.filter((path) => !actual.includes(path)),
  ).toStrictEqual([]);
  expect([...TEMPORARY_FEATURE_EDGES]).toStrictEqual([]);
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

test("a root primitive import of a feature names both paths", () => {
  const sources = new Map([
    ["src/errors.ts", 'import "./contracts/digest.ts";'],
  ]);
  expect(rootPrimitiveEdges(sources)).toStrictEqual([
    "src/errors.ts -> src/contracts/digest.ts",
  ]);
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

test("remote imports stay within remote and its lower features", async () => {
  expect(remoteBoundaryViolations(await repositorySources())).toStrictEqual([]);
});

test("a remote import of the CLI layer names both paths", () => {
  const sources = new Map([
    ["src/remote/addcmd.ts", 'import "../cli/run.ts";'],
  ]);
  expect(remoteBoundaryViolations(sources)).toStrictEqual([
    "src/remote/addcmd.ts -> src/cli/run.ts",
  ]);
});

test("diagnostics imports stay within distribution, contracts, and root", async () => {
  expect(
    diagnosticsBoundaryViolations(await repositorySources()),
  ).toStrictEqual([]);
});

test("a diagnostics import of remote names both paths", () => {
  const sources = new Map([
    ["src/diagnostics/selftest.ts", 'import "../remote/cache.ts";'],
  ]);
  expect(diagnosticsBoundaryViolations(sources)).toStrictEqual([
    "src/diagnostics/selftest.ts -> src/remote/cache.ts",
  ]);
});

test("the root entrypoint delegates only to CLI implementation and primitives", async () => {
  expect(entrypointBoundaryViolations(await repositorySources())).toStrictEqual(
    [],
  );
});

test("a root entrypoint import of a feature names both paths", () => {
  const sources = new Map([["src/cli.ts", 'import "./remote/cache.ts";']]);
  expect(entrypointBoundaryViolations(sources)).toStrictEqual([
    "src/cli.ts -> src/remote/cache.ts",
  ]);
});

test("relative imports stay inside src", async () => {
  expect(sourceEscapeEdges(await repositorySources())).toStrictEqual([]);
});

test("an import escape names both paths", () => {
  const sources = new Map([
    ["src/contracts/digest.ts", 'import "../../outside.ts";'],
  ]);
  expect(sourceEscapeEdges(sources)).toStrictEqual([
    "src/contracts/digest.ts -> outside.ts",
  ]);
});

test("production features contain no cycle", async () => {
  expect(featureCycleEdges(await repositorySources())).toStrictEqual([]);
});

test("every edge in a feature cycle names both source paths", () => {
  const sources = new Map([
    ["src/contracts/digest.ts", 'import "../distribution/gen.ts";'],
    ["src/distribution/gen.ts", 'import "../contracts/digest.ts";'],
  ]);
  expect(featureCycleEdges(sources)).toStrictEqual([
    "src/contracts/digest.ts -> src/distribution/gen.ts",
    "src/distribution/gen.ts -> src/contracts/digest.ts",
  ]);
});

test("production contains no aggregator-only index module", async () => {
  expect(aggregatorIndexFiles(await repositorySources())).toStrictEqual([]);
});

test("an aggregator-only index module is named", () => {
  const sources = new Map([
    ["src/contracts/index.ts", 'export * from "./digest.ts";'],
  ]);
  expect(aggregatorIndexFiles(sources)).toStrictEqual([
    "src/contracts/index.ts",
  ]);
});

test("a type-only aggregator index module is named", () => {
  const sources = new Map([
    ["src/contracts/index.ts", 'export type { Contract } from "./digest.ts";'],
  ]);
  expect(aggregatorIndexFiles(sources)).toStrictEqual([
    "src/contracts/index.ts",
  ]);
});

test("production root contains only primitives and the entrypoint", async () => {
  expect(unknownProductionRoots(await sourceFiles())).toStrictEqual([]);
});

test("an unknown production root module is named", () => {
  expect(unknownProductionRoots(["src/misc.ts"])).toStrictEqual([
    "src/misc.ts",
  ]);
});
