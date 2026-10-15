import type { RobotCapabilities } from "../protocol/capabilities";
import type { MultiAgentMessage } from "../protocol/message";
import type { RobotTransport, RuntimeDataChannel, TransportWriteDiagnostics } from "../transport/RobotTransport";

export type RobotSessionState =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "ready"
  | "reconnecting"
  | "error";

export type RobotHealth = "healthy" | "degraded" | "offline";

export interface RobotSessionMetrics {
  lastReceivedAt: number;
  lastSentAt: number;
  lastHeartbeatAt: number;
  lastPongAt: number;
  latestRttMs: number | null;
  averageRttMs: number | null;
  rttP50Ms: number | null;
  rttP95Ms: number | null;
  rttP99Ms: number | null;
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  messagesDropped: number;
  messagesCoalesced: number;
  invalidPackets: number;
  duplicatePackets: number;
  stalePackets: number;
  reconnectCount: number;
  disconnectCount: number;
  outgoingQueueDepth: number;
  maximumQueueDepth: number;
}

export interface RobotSessionSnapshot {
  sessionId: string;
  robotId?: number;
  hardwareIdentity?: string;
  alias: string;
  deviceName?: string;
  browserIdentity?: string;
  runtimeChannel?: RuntimeDataChannel;
  runtimeUartWithoutResponseSupported?: boolean;
  state: RobotSessionState;
  health: RobotHealth;
  capabilities?: RobotCapabilities;
  metrics: RobotSessionMetrics;
  activeLegacyRobot: boolean;
}

export interface RobotSessionContract {
  readonly sessionId: string;
  robotId?: number;
  hardwareIdentity?: string;
  alias: string;
  readonly transport: RobotTransport;
  state: RobotSessionState;
  capabilities?: RobotCapabilities;
  readonly metrics: RobotSessionMetrics;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: MultiAgentMessage, diagnostics?: PingWriteDiagnostics): Promise<void>;
  nextSequence(): number;
}

export interface RoutingLogEntry {
  id: number;
  time: number;
  sourceRobotId: number;
  targetRobotId: number;
  topicId: number;
  sequence: number;
  status: string;
  rttMs?: number;
}

export interface PingWriteDiagnostics extends TransportWriteDiagnostics {
  packetBytes?: number;
  queueDepthAtEnqueue?: number;
  schedulerQueueMs?: number;
  transportCallMs?: number;
  writeFinishedAt?: number;
  activeWriteAtEnqueue?: string;
  queuedWritesAtEnqueue?: string;
  pendingAcksAtEnqueue?: number;
  blockingWrites?: number;
  blockingWriteMs?: number;
  blockingMessageKinds?: string;
  automaticPingsSkipped?: number;
}

export interface PingTestResult {
  robotId: number;
  sequence: number;
  startedAt: number;
  status: "received" | "timeout" | "error";
  rttMs?: number;
  detail?: string;
  diagnostics?: PingWriteDiagnostics;
  afterWriteMs?: number;
  replyBeforeWriteCompleted?: boolean;
}

export type MessageQos = "latest" | "reliable" | "normal";

export interface PublishRequest {
  targetRobotId: number;
  topicId: number;
  payload: Uint8Array;
  qos: MessageQos;
  ttlMs: number;
  highPriority?: boolean;
}

export interface FleetSnapshot {
  sessions: RobotSessionSnapshot[];
  routingLog: RoutingLogEntry[];
  activeLegacyRobotId: number | null;
}
