import { expect, test } from "bun:test";
import { ConfigError } from "../errors.ts";
import type { Placement } from "./manifest.ts";
import {
  assertFinalDestinationsDisjoint,
  derivePlacementMigrationComponents,
} from "./placement-ownership.ts";

const recorded = (
  dest: string,
  contract: string,
): { skill: string; dest: string; placement: Placement } => ({
  skill: "release-notes",
  dest,
  placement: { contract, src: `tools/${contract}`, digest: "sha256:old" },
});

test("identical dests in different skills are independent final placements", () => {
  expect(() =>
    assertFinalDestinationsDisjoint([
      { skill: "release-notes", contract: "runtime", dest: "scripts/shared" },
      { skill: "review-writer", contract: "helper", dest: "scripts/shared" },
    ]),
  ).not.toThrow();
});

test("identical dests in one skill are conflicting final placements", () => {
  expect(() =>
    assertFinalDestinationsDisjoint([
      { skill: "release-notes", contract: "runtime", dest: "scripts/shared" },
      { skill: "release-notes", contract: "helper", dest: "scripts/shared" },
    ]),
  ).toThrow(ConfigError);
});

test("ancestor and descendant dests in one skill are conflicting final placements", () => {
  expect(() =>
    assertFinalDestinationsDisjoint([
      { skill: "release-notes", contract: "runtime", dest: "scripts/shared" },
      {
        skill: "release-notes",
        contract: "helper",
        dest: "scripts/shared/bin",
      },
    ]),
  ).toThrow(ConfigError);
});

test("one old directory owns a migration to its child file destinations", () => {
  expect(
    derivePlacementMigrationComponents(
      [
        recorded("scripts/runtime/", "runtime"),
        recorded("assets/logo.svg", "branding"),
      ],
      [
        {
          skill: "release-notes",
          contract: "runtime-python",
          dest: "scripts/runtime/runtime.py",
        },
        {
          skill: "release-notes",
          contract: "runtime-helper",
          dest: "scripts/runtime/lib/helper.py",
        },
        {
          skill: "release-notes",
          contract: "branding",
          dest: "assets/new-logo.svg",
        },
      ],
    ),
  ).toStrictEqual([
    {
      skill: "release-notes",
      oldDestinations: [recorded("scripts/runtime/", "runtime")],
      finalDestinations: [
        {
          skill: "release-notes",
          contract: "runtime-python",
          dest: "scripts/runtime/runtime.py",
        },
        {
          skill: "release-notes",
          contract: "runtime-helper",
          dest: "scripts/runtime/lib/helper.py",
        },
      ],
      outermostDest: "scripts/runtime/",
    },
  ]);
});

test("one new directory owns a migration from its child file placements", () => {
  expect(
    derivePlacementMigrationComponents(
      [
        recorded("scripts/runtime/runtime.py", "runtime-python"),
        recorded("scripts/runtime/lib/helper.py", "runtime-helper"),
        recorded("scripts/other/run.py", "other"),
      ],
      [
        {
          skill: "release-notes",
          contract: "runtime",
          dest: "scripts/runtime/",
        },
        {
          skill: "release-notes",
          contract: "other",
          dest: "scripts/other/new.py",
        },
      ],
    ),
  ).toStrictEqual([
    {
      skill: "release-notes",
      oldDestinations: [
        recorded("scripts/runtime/runtime.py", "runtime-python"),
        recorded("scripts/runtime/lib/helper.py", "runtime-helper"),
      ],
      finalDestinations: [
        {
          skill: "release-notes",
          contract: "runtime",
          dest: "scripts/runtime/",
        },
      ],
      outermostDest: "scripts/runtime/",
    },
  ]);
});

test("a common parent that no placement owns does not join migration components", () => {
  expect(
    derivePlacementMigrationComponents(
      [recorded("scripts/left/old.py", "left")],
      [
        {
          skill: "release-notes",
          contract: "right",
          dest: "scripts/right/new.py",
        },
      ],
    ),
  ).toStrictEqual([]);
});

test("a deeply nested valid destination is classified without exhausting the call stack", () => {
  const directory = `${Array.from({ length: 200_000 }, () => "segment").join("/")}/`;
  const child = `${directory}file.txt`;
  const old = recorded(directory, "runtime");
  const final = {
    skill: "release-notes",
    contract: "runtime-file",
    dest: child,
  };

  expect(derivePlacementMigrationComponents([old], [final])).toStrictEqual([
    {
      skill: "release-notes",
      oldDestinations: [old],
      finalDestinations: [final],
      outermostDest: directory,
    },
  ]);
});

test("many sibling destinations are checked with a bounded number of path reads", () => {
  const width = 2_048;
  let destinationReads = 0;
  const destinations = Array.from({ length: width }, (_, index) => {
    const dest = `scripts/commands/command-${index}.py`;
    return {
      skill: "release-notes",
      contract: `command-${index}`,
      get dest() {
        destinationReads++;
        return dest;
      },
    };
  });

  expect(() => assertFinalDestinationsDisjoint(destinations)).not.toThrow();
  expect(destinationReads).toBeLessThanOrEqual(width * 2);
});
