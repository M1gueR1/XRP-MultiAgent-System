import type { RobotFleetManager } from "../fleet/RobotFleetManager";
import type { PingTestResult } from "../fleet/types";

export interface SingleRobotRttTestOptions {
  robotId: number;
  count: number;
  pauseAutomaticPings: boolean;
  uartWithoutResponse?: boolean;
  uartChunkSizeBytes?: 20 | 55;
  signal: AbortSignal;
  onResult: (result: PingTestResult) => void;
}

function waitBetweenTests(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function runSingleRobotRttTest(fleet: RobotFleetManager, options: SingleRobotRttTestOptions): Promise<void> {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 100) {
    throw new RangeError("Sample count must be between 1 and 100.");
  }
  const uartChunkSize = options.uartChunkSizeBytes ?? 20;
  if (uartChunkSize !== 20 && uartChunkSize !== 55) throw new RangeError("UART chunk size must be 20 or 55 bytes.");
  if (uartChunkSize === 55 && !options.uartWithoutResponse) {
    throw new Error("55-byte UART writes require the without-response experiment.");
  }
  const requireSingleRobot = () => {
    const ready = fleet.getReadySessions();
    if (ready.length !== 1 || ready[0].robotId !== options.robotId) {
      throw new Error("Single-XRP test requires exactly one ready robot.");
    }
    const channel = ready[0].transport.runtimeChannel;
    if (channel !== "ble-data" && channel !== "ble-uart") {
      throw new Error("Single-XRP RTT test requires a Bluetooth connection.");
    }
    return ready[0].sessionId;
  };
  const sessionId = requireSingleRobot();
  const transport = fleet.getReadySessions()[0].transport;
  if (options.uartWithoutResponse && (transport.runtimeChannel !== "ble-uart" ||
    !transport.supportsRuntimeUartWithoutResponse || !transport.useRuntimeUartWithoutResponse)) {
    throw new Error("This XRP does not support the UART without-response experiment. Prepare its BLE library and reconnect.");
  }
  const resume = options.pauseAutomaticPings ? fleet.pauseAutomaticPings(options.robotId) : () => undefined;
  let restoreWrites: (() => void) | undefined;
  try {
    if (options.uartWithoutResponse) restoreWrites = transport.useRuntimeUartWithoutResponse!(uartChunkSize);
    for (let index = 0; index < options.count && !options.signal.aborted; index += 1) {
      if (requireSingleRobot() !== sessionId) throw new Error("Robot session changed during the test.");
      const result = await fleet.pingForTest(options.robotId, 5000, options.signal);
      if (options.signal.aborted) break;
      options.onResult(result);
      if (result.status === "error") throw new Error(result.detail ?? "RTT test failed.");
      if (index + 1 < options.count) await waitBetweenTests(options.signal);
    }
  } finally {
    try { restoreWrites?.(); } finally { resume(); }
  }
}
