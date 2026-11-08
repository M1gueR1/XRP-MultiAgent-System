// Private experiment topic, deliberately separate from drive and classroom messages.
export const RATE_TEST_TOPIC = 0x7f30;
export const RATE_TEST_HZ = 30;
export const RATE_TEST_RATES = [5, 10, 30] as const;
// Cumulative robot-clock microseconds; nested stages overlap, do not sum them.
export const RATE_DIAGNOSTIC_KEYS = ["streamBytes", "readCalls", "readUs", "decodedFrames", "decodeUs", "transportUs", "nodePollCalls", "nodePollUs", "nodePollMaxUs", "loopGapMaxUs", "droppedChunks", "handlerUs", "writeUs"] as const;
export type RateDiagnostics = Record<typeof RATE_DIAGNOSTIC_KEYS[number], number>;
const READER_MODES = ["stdin-bytewise", "ble-uart-buffered-32", "ble-data"] as const;
export const RATE_TEST_VERSION = 1;
export const RateTestOp = { START: 1, SAMPLE: 2, STOP: 3, REPORT: 4, CANCEL: 5, BUSY: 6 } as const;

export interface RateReceiverReport {
  runId: number;
  phase: "armed" | "receiving" | "final";
  received: number;
  withinWindow: number;
  duplicates: number;
  outOfOrder: number;
  invalid: number;
  lastSequence: number | null;
  elapsedMs: number;
  lastArrivalMs: number;
  maxGapMs: number;
  p95GapMs: number | null;
  afterWindow: number;
  diagnostics?: RateDiagnostics;
  receiverRevision?: number;
  readerMode?: typeof READER_MODES[number];
}

export function rateCommand(op: number, runId: number, sequenceOrSeconds = 0, hz = RATE_TEST_HZ): Uint8Array {
  const bytes = new Uint8Array(op === RateTestOp.START ? 10 : op === RateTestOp.SAMPLE ? 12 : 6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, RATE_TEST_VERSION);
  view.setUint8(1, op);
  view.setUint32(2, runId, true);
  if (op === RateTestOp.START) {
    view.setUint16(6, hz, true);
    view.setUint16(8, sequenceOrSeconds, true);
  } else if (op === RateTestOp.SAMPLE) {
    view.setUint16(6, sequenceOrSeconds, true);
    // Last four bytes are neutral synthetic velocity values, never motor commands.
  }
  return bytes;
}

export function decodeRateReport(bytes: Uint8Array): RateReceiverReport | undefined {
  const diagnosticLength = 35 + RATE_DIAGNOSTIC_KEYS.length * 4;
  const hasMetadata = bytes.length === 37 || bytes.length === diagnosticLength + 2;
  const hasDiagnostics = bytes.length === diagnosticLength || bytes.length === diagnosticLength + 2;
  if ((!hasMetadata && bytes.length !== 35 && !hasDiagnostics) || bytes[0] !== RATE_TEST_VERSION || bytes[1] !== RateTestOp.REPORT) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const phase = ["armed", "receiving", "final"][bytes[6] - 1] as RateReceiverReport["phase"] | undefined;
  if (!phase) return;
  if (hasDiagnostics && phase !== "final") return;
  const metadataOffset = hasDiagnostics ? diagnosticLength : 35;
  const receiverRevision = hasMetadata ? bytes[metadataOffset] : undefined;
  const readerMode = hasMetadata ? READER_MODES[bytes[metadataOffset + 1]] : undefined;
  if (hasMetadata && (receiverRevision !== 6 || !readerMode)) return;
  const diagnostics = hasDiagnostics ? Object.fromEntries(RATE_DIAGNOSTIC_KEYS.map((key, i) => [key, view.getUint32(35 + i * 4, true)])) as RateDiagnostics : undefined;
  const received = view.getUint16(7, true), withinWindow = view.getUint16(9, true);
  const afterWindow = view.getUint16(33, true), lastSequence = view.getUint16(17, true);
  if (received > 1800 || withinWindow + afterWindow !== received || (lastSequence !== 65535 && lastSequence >= 1800)) return;
  const gap = view.getUint16(31, true);
  return {
    runId: view.getUint32(2, true), phase, received, withinWindow,
    duplicates: view.getUint16(11, true), outOfOrder: view.getUint16(13, true), invalid: view.getUint16(15, true),
    lastSequence: lastSequence === 65535 ? null : lastSequence,
    elapsedMs: view.getUint32(19, true), lastArrivalMs: view.getUint32(23, true), maxGapMs: view.getUint32(27, true),
    p95GapMs: gap === 65535 ? null : gap, afterWindow, diagnostics, receiverRevision, readerMode,
  };
}
