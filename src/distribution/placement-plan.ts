import { buildPlacementPlan } from "./placements.ts";

export type PlacementPlan = import("./placements.ts").PlacementPlan;
export type PlannedDest = import("./placements.ts").PlannedDest;

export const planPlacements: typeof buildPlacementPlan = async (...args) =>
  await buildPlacementPlan(...args);
