import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSnapshot, RobotFleetManager } from "@/multiagent";
import { createSessionMetrics } from "@/multiagent/fleet/metrics";
import { runSustainedRateTest, type SustainedRateResult } from "@/multiagent/benchmark/SustainedRateTest";
import { saveAs } from "file-saver";
import SustainedRateTestPanel from "../SustainedRateTestPanel";

vi.mock("@/multiagent/benchmark/SustainedRateTest", () => ({ runSustainedRateTest: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));
const snapshot: FleetSnapshot = { activeLegacyRobotId: null, routingLog: [], sessions: [{
  sessionId: "one", robotId: 1, alias: "XRP-724e7", runtimeChannel: "ble-uart",
  runtimeUartWithoutResponseSupported: true, state: "ready", health: "healthy", activeLegacyRobot: false,
  metrics: createSessionMetrics(),
}] };
const fleet = {} as RobotFleetManager;

describe("30 Hz dialog", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires current interval confirmation, shows partial data and exports JSON", async () => {
    const onBusyChange = vi.fn();
    vi.mocked(runSustainedRateTest).mockResolvedValue({
      runId: 77, requestedHz: 10, status: "error", error: "Receiver disconnected", samples: [],
      summary: { written: 10, skippedBackpressure: 2, skippedTimer: 0, receiverHzOverScheduledWindow: null, missingAtReceiver: null },
      receiver: { received: 8 },
    } as unknown as SustainedRateResult);
    render(<SustainedRateTestPanel snapshot={snapshot} fleet={fleet} busy={false} onBusyChange={onBusyChange} />);
    fireEvent.click(screen.getByRole("button", { name: "30 Hz test" }));
    expect(screen.getByRole("combobox", { name: "Requested rate" })).toHaveValue("5");
    fireEvent.change(screen.getByRole("combobox", { name: "Requested rate" }), { target: { value: "10" } });
    const start = screen.getByRole("button", { name: "Start 60-second test" });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "15 ms confirmed in Windows" }));
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Receiver disconnected"));
    expect(runSustainedRateTest).toHaveBeenCalledWith(fleet, expect.objectContaining({ robotId: 1, requestedHz: 10, uartWithoutResponse: true, intervalConfirmed: true }));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole("checkbox", { name: "15 ms confirmed in Windows" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Export 30 Hz JSON" }));
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), "xrp-10hz-77.json");
  });

  it("keeps the test modal open while running and cancels through its signal", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(runSustainedRateTest).mockImplementation((_fleet, options) => {
      signal = options.signal;
      return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ status: "cancelled", runId: 4 } as SustainedRateResult), { once: true }));
    });
    render(<SustainedRateTestPanel snapshot={snapshot} fleet={fleet} busy={false} onBusyChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "30 Hz test" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "15 ms confirmed in Windows" }));
    fireEvent.click(screen.getByRole("button", { name: "Start 60-second test" }));
    expect(screen.getByRole("button", { name: "Close 30 Hz test" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop test" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close 30 Hz test" })).toBeEnabled());
  });

  it("disables entry for USB, multiple XRPs and other running diagnostics", () => {
    const { rerender } = render(<SustainedRateTestPanel snapshot={snapshot} fleet={fleet} busy onBusyChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "30 Hz test" })).toBeDisabled();
    rerender(<SustainedRateTestPanel snapshot={{ ...snapshot, sessions: [{ ...snapshot.sessions[0], runtimeChannel: "usb" }] }} fleet={fleet} busy={false} onBusyChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "30 Hz test" })).toBeDisabled();
    rerender(<SustainedRateTestPanel snapshot={{ ...snapshot, sessions: [snapshot.sessions[0], { ...snapshot.sessions[0], robotId: 2 }] }} fleet={fleet} busy={false} onBusyChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "30 Hz test" })).toBeDisabled();
  });
});
