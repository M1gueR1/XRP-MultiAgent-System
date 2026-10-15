import { describe, expect, it, vi } from "vitest";
import { runSingleRobotRttTest } from "../benchmark/SingleRobotRttTest";
import type { RobotFleetManager } from "../fleet/RobotFleetManager";
import type { PingTestResult } from "../fleet/types";

function fixture() {
  const resume = vi.fn();
  const robot = { sessionId: "one", robotId: 1, transport: { runtimeChannel: "ble-data" } };
  const fleet = {
    getReadySessions: vi.fn(() => [robot]),
    pauseAutomaticPings: vi.fn(() => resume),
    pingForTest: vi.fn(async () => ({ robotId: 1, sequence: 1, startedAt: Date.now(), status: "received", rttMs: 10 } as PingTestResult)),
  };
  const controller = new AbortController();
  const options = { robotId: 1, count: 2, pauseAutomaticPings: true, signal: controller.signal, onResult: vi.fn() };
  return { fleet, manager: fleet as unknown as RobotFleetManager, options, resume, controller, robot };
}

describe("single robot RTT series", () => {
  it.each(["received", "timeout", "error", "cancel"])("restores UART writes after %s results", async (outcome) => {
    const { manager, options, robot, fleet, controller, resume } = fixture();
    const restore = vi.fn();
    const configure = vi.fn(() => restore);
    robot.transport.runtimeChannel = "ble-uart";
    Object.assign(robot.transport, { supportsRuntimeUartWithoutResponse: true, useRuntimeUartWithoutResponse: configure });
    const experiment = { ...options, count: 1, uartWithoutResponse: true, uartChunkSizeBytes: 55 as const };
    if (outcome === "error") fleet.pingForTest.mockRejectedValueOnce(new Error("write failed"));
    if (outcome === "timeout") fleet.pingForTest.mockResolvedValueOnce({ robotId: 1, sequence: 1, startedAt: 0, status: "timeout" });
    if (outcome === "cancel") options.onResult.mockImplementation(() => controller.abort());
    if (outcome === "error") await expect(runSingleRobotRttTest(manager, experiment)).rejects.toThrow("write failed");
    else await runSingleRobotRttTest(manager, experiment);
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith(55);
    expect(restore).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("rejects 55-byte writes without the UART experiment and invalid sizes before pausing or sending", async () => {
    const { manager, options, fleet } = fixture();
    await expect(runSingleRobotRttTest(manager, { ...options, uartChunkSizeBytes: 55 })).rejects.toThrow("require the without-response");
    await expect(runSingleRobotRttTest(manager, { ...options, uartChunkSizeBytes: 21 as 20 })).rejects.toThrow("20 or 55");
    expect(fleet.pingForTest).not.toHaveBeenCalled();
    expect(fleet.pauseAutomaticPings).not.toHaveBeenCalled();
  });

  it("rejects unsupported UART experiments before sending or pausing", async () => {
    const { manager, options, fleet } = fixture();
    await expect(runSingleRobotRttTest(manager, { ...options, uartWithoutResponse: true })).rejects.toThrow("does not support");
    expect(fleet.pingForTest).not.toHaveBeenCalled();
    expect(fleet.pauseAutomaticPings).not.toHaveBeenCalled();
  });

  it("runs sequential probes and restores automatic pings", async () => {
    const { fleet, manager, options, resume } = fixture();
    await runSingleRobotRttTest(manager, options);
    expect(fleet.pingForTest).toHaveBeenCalledTimes(2);
    expect(options.onResult).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("restores automatic pings when the test fails or is cancelled", async () => {
    const failing = fixture();
    failing.fleet.pingForTest.mockRejectedValueOnce(new Error("disconnected"));
    await expect(runSingleRobotRttTest(failing.manager, failing.options)).rejects.toThrow("disconnected");
    expect(failing.resume).toHaveBeenCalledOnce();
    const cancelled = fixture();
    cancelled.options.onResult.mockImplementation(() => cancelled.controller.abort());
    await runSingleRobotRttTest(cancelled.manager, cancelled.options);
    expect(cancelled.fleet.pingForTest).toHaveBeenCalledOnce();
    expect(cancelled.resume).toHaveBeenCalledOnce();
  });

  it("rejects multiple robots and USB, and records timeouts rather than silently losing them", async () => {
    const multiple = fixture();
    multiple.fleet.getReadySessions.mockReturnValue([multiple.robot, { ...multiple.robot, robotId: 2 }]);
    await expect(runSingleRobotRttTest(multiple.manager, multiple.options)).rejects.toThrow("exactly one");
    expect(multiple.fleet.pauseAutomaticPings).not.toHaveBeenCalled();
    const usb = fixture();
    usb.robot.transport.runtimeChannel = "usb";
    await expect(runSingleRobotRttTest(usb.manager, usb.options)).rejects.toThrow("Bluetooth");
    const timeout = fixture();
    timeout.fleet.pingForTest.mockResolvedValue({ robotId: 1, sequence: 1, startedAt: 0, status: "timeout" });
    await runSingleRobotRttTest(timeout.manager, timeout.options);
    expect(timeout.options.onResult).toHaveBeenCalledTimes(2);
    expect(timeout.resume).toHaveBeenCalledOnce();
  });
});
