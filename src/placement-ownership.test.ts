import { expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { assertFinalDestinationsDisjoint } from "./placement-ownership.ts";

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
