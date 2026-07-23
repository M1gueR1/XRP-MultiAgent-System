import { describe, expect, it } from "vitest";
import { runVirtualFleetSimulation } from "../simulation/runVirtualFleetSimulation";

describe("virtual fleet logical load", () => {
  it.each([3, 6])("keeps %i robot sessions bounded at 20 Hz for 60 simulated seconds", async (robots) => {
    const result = await runVirtualFleetSimulation(robots, 60, 20);
    console.info("virtual-fleet-result", JSON.stringify(result));
    expect(result.updatesRequested).toBe(robots * 1200);
    expect(result.maximumQueueDepth).toBeLessThanOrEqual(2);
    expect(result.messagesCoalesced).toBeGreaterThan(0);
    expect(result.messagesDropped).toBe(0);
    expect(result.wrongRobotDeliveries).toBe(0);
  });
});
