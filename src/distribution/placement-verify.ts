import { checkPlacementViolations } from "./placements.ts";

export const placementViolations: typeof checkPlacementViolations = async (
  ...args
) => await checkPlacementViolations(...args);
