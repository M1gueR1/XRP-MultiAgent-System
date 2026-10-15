import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamMessageLog from "../TeamMessageLog";
import type { FleetSnapshot, RobotFleetManager } from "@/multiagent";
import { createSessionMetrics } from "@/multiagent/fleet/metrics";
import { saveAs } from "file-saver";

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

describe("TeamMessageLog manual results", () => {
  it("offers the UART experiment only when advertised and exports the actual write mode", async () => {
    const robot = { sessionId: "uart", robotId: 1, alias: "XRP UART", runtimeChannel: "ble-uart" as const,
      runtimeUartWithoutResponseSupported: false, state: "ready" as const, health: "healthy" as const,
      activeLegacyRobot: false, metrics: createSessionMetrics() };
    const snapshot: FleetSnapshot = { activeLegacyRobotId: null, routingLog: [], sessions: [robot] };
    const restore = vi.fn();
    const configure = vi.fn(() => restore);
    const fleet = {
      getReadySessions: () => [{ ...robot, transport: { runtimeChannel: "ble-uart", supportsRuntimeUartWithoutResponse: true,
        useRuntimeUartWithoutResponse: configure } }],
      pingForTest: vi.fn(async () => ({ robotId: 1, sequence: 1, startedAt: Date.now(), status: "received" as const,
        rttMs: 50, diagnostics: { channel: "ble-uart" as const, writeMode: "without-response" as const,
          encodedBytes: 55, chunks: 3, attempts: 3, retries: 0 } })),
    } as unknown as RobotFleetManager;
    const { rerender } = render(<TeamMessageLog snapshot={snapshot} fleet={fleet} />);
    fireEvent.click(screen.getByRole("button", { name: "RTT diagnostic" }));
    expect(screen.getByRole("checkbox", { name: "Use UART writes without response" })).toBeDisabled();
    rerender(<TeamMessageLog snapshot={{ ...snapshot, sessions: [{ ...robot, runtimeUartWithoutResponseSupported: true }] }} fleet={fleet} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Samples" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use UART writes without response" }));
    fireEvent.click(screen.getByRole("button", { name: "Start RTT test" }));
    await waitFor(() => expect(screen.getByText("1/1 received")).toBeInTheDocument());
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith(20);
    expect(restore).toHaveBeenCalledOnce();
    expect(screen.getByText("Write mode: without-response")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export test results as CSV" }));
    const blob = vi.mocked(saveAs).mock.calls.at(-1)![0] as Blob;
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
    expect(csv).toContain('"write_mode","uart_without_response_requested"');
    expect(csv).toContain('"without-response","true"');
  });

  it("runs a single-XRP diagnostic and exports transport timings and background mode", async () => {
    const snapshot: FleetSnapshot = {
      activeLegacyRobotId: null, routingLog: [], sessions: [{
        sessionId: "one", robotId: 1, alias: "Blue XRP", runtimeChannel: "ble-data", state: "ready",
        health: "healthy", activeLegacyRobot: false, metrics: createSessionMetrics(),
      }],
    };
    const resume = vi.fn();
    const pingForTest = vi.fn(async () => ({
      robotId: 1, sequence: 10, startedAt: Date.now(), status: "received" as const, rttMs: 40,
      diagnostics: { channel: "ble-data" as const, packetBytes: 22, encodedBytes: 22, schedulerQueueMs: 1,
        transportCallMs: 9, gattQueueMs: 2, gattOperationMs: 7, chunks: 2, attempts: 2, retries: 0,
        activeWriteAtEnqueue: "HEARTBEAT", queuedWritesAtEnqueue: "DATA:TEAM_DIRECTORY", pendingAcksAtEnqueue: 1,
        blockingWrites: 2, blockingWriteMs: 1, blockingMessageKinds: "HEARTBEAT|DATA:TEAM_DIRECTORY", automaticPingsSkipped: 3 },
      afterWriteMs: 30, replyBeforeWriteCompleted: false,
    }));
    const fleet = {
      getReadySessions: () => [{ ...snapshot.sessions[0], transport: { runtimeChannel: "ble-data" } }],
      pauseAutomaticPings: vi.fn(() => resume), pingForTest,
    } as unknown as RobotFleetManager;
    render(<TeamMessageLog snapshot={snapshot} fleet={fleet} />);
    fireEvent.click(screen.getByRole("button", { name: "RTT diagnostic" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Samples" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pause automatic pings" }));
    fireEvent.click(screen.getByRole("button", { name: "Start RTT test" }));
    await waitFor(() => expect(screen.getByText("2/2 received")).toBeInTheDocument());
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(screen.getByText("Mean: 40.0 ms")).toBeInTheDocument();
    expect(screen.getByText("Automatic pings: paused")).toBeInTheDocument();
    expect(screen.getAllByText("BLE DATA")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Export test results as CSV" }));
    const blob = vi.mocked(saveAs).mock.calls.at(-1)![0] as Blob;
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
    expect(csv).toContain('"transport_call_ms"');
    expect(csv).toContain('"gatt_write_retries"');
    expect(csv).toContain('"paused","ble-data","22","22"');
    expect(csv).toContain('"diagnostic_version","automatic_ping_policy","active_write_at_enqueue"');
    expect(csv).toContain('"blocking_write_ms","blocking_message_kinds","automatic_pings_skipped"');
    expect(csv).toContain('"4","paused","HEARTBEAT","DATA:TEAM_DIRECTORY","1","2","1","HEARTBEAT|DATA:TEAM_DIRECTORY","3"');
    expect(screen.getAllByText("HEARTBEAT|DATA:TEAM_DIRECTORY")).toHaveLength(2);
  });

  it("confirms the 55-byte profile, records requested and actual sizes, and does not run after a declined confirmation", async () => {
    const robot = { sessionId: "uart55", robotId: 1, alias: "XRP-724e7", runtimeChannel: "ble-uart" as const,
      runtimeUartWithoutResponseSupported: true, state: "ready" as const, health: "healthy" as const,
      activeLegacyRobot: false, metrics: createSessionMetrics() };
    const snapshot: FleetSnapshot = { activeLegacyRobotId: null, routingLog: [], sessions: [robot] };
    const restore = vi.fn();
    const configure = vi.fn(() => restore);
    const pingForTest = vi.fn(async () => ({ robotId: 1, sequence: 1, startedAt: Date.now(), status: "received" as const,
      rttMs: 50, diagnostics: { channel: "ble-uart" as const, writeMode: "without-response" as const,
        encodedBytes: 55, chunks: 1, chunkSizeBytes: 55, attempts: 1, retries: 0 } }));
    const fleet = {
      getReadySessions: () => [{ ...robot, transport: { runtimeChannel: "ble-uart", supportsRuntimeUartWithoutResponse: true,
        useRuntimeUartWithoutResponse: configure } }], pingForTest,
    } as unknown as RobotFleetManager;
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<TeamMessageLog snapshot={snapshot} fleet={fleet} />);
      fireEvent.click(screen.getByRole("button", { name: "RTT diagnostic" }));
      const toggle55 = screen.getByRole("checkbox", { name: "Use 55-byte UART writes" });
      expect(toggle55).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: "Use UART writes without response" }));
      expect(toggle55).toBeEnabled();
      fireEvent.click(toggle55);
      fireEvent.change(screen.getByRole("spinbutton", { name: "Samples" }), { target: { value: "1" } });
      fireEvent.click(screen.getByRole("button", { name: "Start RTT test" }));
      expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("MTU is at least 58"));
      expect(configure).not.toHaveBeenCalled();
      expect(pingForTest).not.toHaveBeenCalled();
      confirmation.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Start RTT test" }));
      await waitFor(() => expect(screen.getByText("1/1 received")).toBeInTheDocument());
      expect(configure).toHaveBeenCalledWith(55);
      expect(restore).toHaveBeenCalledOnce();
      expect(screen.getByText("GATT chunk size: 55 bytes")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Export test results as CSV" }));
      const blob = vi.mocked(saveAs).mock.calls.at(-1)![0] as Blob;
      const csv = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(blob);
      });
      expect(csv).toContain('"uart_chunk_size_requested","gatt_write_chunk_size_bytes"');
      expect(csv).toContain('"without-response","true","55","55"');
      fireEvent.click(screen.getByRole("button", { name: "RTT diagnostic" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Use UART writes without response" }));
      expect(screen.getByRole("checkbox", { name: "Use 55-byte UART writes" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Use 55-byte UART writes" })).toBeDisabled();
    } finally {
      confirmation.mockRestore();
    }
  });

  it("does not offer a single-XRP series for USB or multiple ready robots", () => {
    const snapshot: FleetSnapshot = {
      activeLegacyRobotId: null, routingLog: [], sessions: [1, 2].map((robotId) => ({
        sessionId: String(robotId), robotId, alias: `XRP ${robotId}`, runtimeChannel: "ble-data",
        state: "ready", health: "healthy", activeLegacyRobot: false, metrics: createSessionMetrics(),
      })),
    };
    const fleet = { getReadySessions: () => snapshot.sessions } as unknown as RobotFleetManager;
    render(<TeamMessageLog snapshot={snapshot} fleet={fleet} />);
    fireEvent.click(screen.getByRole("button", { name: "RTT diagnostic" }));
    expect(screen.getByRole("button", { name: "Start RTT test" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("one ready Bluetooth XRP");
  });
  it("keeps manual results stable while automatic traffic continues and allows clearing them", async () => {
    const snapshot: FleetSnapshot = {
      activeLegacyRobotId: null, routingLog: [],
      sessions: [1, 2].map((robotId) => ({
        sessionId: String(robotId), robotId, alias: `XRP ${robotId}`, state: "ready", health: "healthy",
        activeLegacyRobot: false, metrics: createSessionMetrics(),
      })),
    };
    const pingForTest = vi.fn(async (robotId: number) => ({
      robotId, sequence: robotId + 10, startedAt: Date.now(), status: "received" as const, rttMs: robotId * 12.5,
    }));
    const fleet = { getReadySessions: () => snapshot.sessions, pingForTest } as unknown as RobotFleetManager;
    const { rerender } = render(<TeamMessageLog snapshot={snapshot} fleet={fleet} />);
    fireEvent.click(screen.getByRole("button", { name: "Test message" }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText("2/2 received")).toBeInTheDocument());
    expect(pingForTest).toHaveBeenCalledTimes(2);
    expect(screen.getByText("12.5")).toBeInTheDocument();
    expect(screen.getByText("25.0")).toBeInTheDocument();
    rerender(<TeamMessageLog snapshot={{ ...snapshot, routingLog: [{
      id: 1, time: Date.now(), sourceRobotId: 1, targetRobotId: 0, topicId: 0, sequence: 99,
      status: "pong", rttMs: 900,
    }] }} fleet={fleet} />);
    expect(screen.queryByText(/900\.0ms/)).not.toBeInTheDocument();
    expect(screen.getByText("12.5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "All traffic" }));
    expect(screen.getByText("pong 900.0ms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Test results" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear test results" }));
    expect(screen.getByText("No manual tests yet.")).toBeInTheDocument();
  });
});
