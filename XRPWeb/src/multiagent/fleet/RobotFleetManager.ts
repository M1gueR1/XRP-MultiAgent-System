import {
  BROADCAST_ROBOT_ID,
  LAPTOP_COORDINATOR_ID,
  MAX_ASSIGNED_ROBOT_ID,
  MIN_ASSIGNED_ROBOT_ID,
  MultiAgentFlag,
  MultiAgentMessageKind,
  MultiAgentTopic,
  MULTI_AGENT_PROTOCOL_VERSION,
  UNASSIGNED_ROBOT_ID,
} from "../protocol/constants";
import { decodeHelloPayload, encodeHelloAckPayload } from "../protocol/capabilities";
import type { MultiAgentMessage } from "../protocol/message";
import type { RobotTransport } from "../transport/RobotTransport";
import { WebBluetoothRuntimeTransport } from "../transport/WebBluetoothRuntimeTransport";
import { monotonicNow, RttTracker } from "./metrics";
import { RobotSession } from "./RobotSession";
import type {
  FleetSnapshot,
  PublishRequest,
  RobotSessionSnapshot,
  RoutingLogEntry,
} from "./types";

const MAX_RECENT_MESSAGES = 512;
const MAX_ROUTING_LOG = 200;
const HEARTBEAT_INTERVAL_MS = 1000;
const ROBOT_HEARTBEAT_TIMEOUT_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 5000;
const STORAGE_KEY = "xrp-multiagent-known-robots-v1";

interface StoredRobot {
  robotId: number;
  alias: string;
}

type TopicListener = (message: MultiAgentMessage) => void;

export class RobotFleetManager {
  private readonly sessions = new Map<string, RobotSession>();
  private readonly robotIds = new Map<number, RobotSession>();
  private readonly subscribers = new Set<(snapshot: FleetSnapshot) => void>();
  private readonly topicListeners = new Map<number, Set<TopicListener>>();
  private readonly routingLog: RoutingLogEntry[] = [];
  private readonly recentMessages = new Map<string, number>();
  private readonly pingStartedAt = new Map<string, number>();
  private readonly rttTrackers = new Map<string, RttTracker>();
  private readonly externalSessions = new Map<string, string>();
  private readonly preferProvidedAlias = new Set<string>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private logId = 0;
  private nextRobotId = MIN_ASSIGNED_ROBOT_ID;
  private activeLegacyRobotId: number | null = null;

  async addRobot(
    transport: RobotTransport,
    alias?: string,
    options: { externalKey?: string; preferProvidedAlias?: boolean } = {},
  ): Promise<RobotSession> {
    const sessionId = this.createSessionId();
    const session = new RobotSession(
      sessionId,
      alias ?? transport.deviceName ?? `Robot ${this.sessions.size + 1}`,
      transport,
      {
        onMessage: (source, message, arrivedAt) => void this.handleIncoming(source, message, arrivedAt),
        onStateChanged: () => this.notify(),
      },
    );
    this.sessions.set(sessionId, session);
    if (options.externalKey) this.externalSessions.set(options.externalKey, sessionId);
    if (options.preferProvidedAlias) this.preferProvidedAlias.add(sessionId);
    this.rttTrackers.set(sessionId, new RttTracker());
    this.notify();
    await this.connectRobot(sessionId);
    return session;
  }

  async attachExternalRobot(
    externalKey: string,
    transport: RobotTransport,
    alias: string,
  ): Promise<RobotSession> {
    const existingId = this.externalSessions.get(externalKey);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing) {
        existing.alias = alias.trim().slice(0, 40) || existing.alias;
        this.preferProvidedAlias.add(existing.sessionId);
        if (existing.state === 'disconnected' || existing.state === 'error') {
          await this.connectRobot(existing.sessionId);
        }
        if (existing.state === 'ready') void this.broadcastTeamDirectory();
        this.notify();
        return existing;
      }
      this.externalSessions.delete(externalKey);
    }
    return this.addRobot(transport, alias, {
      externalKey,
      preferProvidedAlias: true,
    });
  }

  /** Resets per-program routing state while preserving the physical IDE session and stable robot ID. */
  prepareExternalRobotRun(externalKey: string): void {
    const sessionId = this.externalSessions.get(externalKey);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.robotId !== undefined) this.forgetRecentMessagesFrom(session.robotId);
    for (const key of this.pingStartedAt.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.pingStartedAt.delete(key);
    }
    session.prepareForRuntimeRestart();
    this.notify();
  }

  async removeExternalRobot(externalKey: string): Promise<void> {
    const sessionId = this.externalSessions.get(externalKey);
    if (!sessionId) return;
    this.externalSessions.delete(externalKey);
    if (this.sessions.has(sessionId)) await this.removeRobot(sessionId);
  }

  renameExternalRobot(externalKey: string, alias: string): void {
    const sessionId = this.externalSessions.get(externalKey);
    if (!sessionId || !this.sessions.has(sessionId)) return;
    this.renameRobot(sessionId, alias);
  }

  async addBluetoothRobot(): Promise<RobotSession> {
    const transport = await WebBluetoothRuntimeTransport.requestFromUser();
    return this.addRobot(transport, transport.deviceName);
  }

  async removeRobot(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.robotId !== undefined) this.robotIds.delete(session.robotId);
    await session.disconnect();
    session.dispose();
    this.sessions.delete(sessionId);
    this.preferProvidedAlias.delete(sessionId);
    for (const [externalKey, linkedSessionId] of this.externalSessions) {
      if (linkedSessionId === sessionId) this.externalSessions.delete(externalKey);
    }
    this.rttTrackers.delete(sessionId);
    if (this.activeLegacyRobotId === session.robotId) this.activeLegacyRobotId = null;
    this.stopHeartbeatIfIdle();
    this.notify();
  }

  async connectRobot(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.connect();
    setTimeout(() => {
      if (session.state === "handshaking") {
        session.markError();
        this.log(UNASSIGNED_ROBOT_ID, LAPTOP_COORDINATOR_ID, 0, 0, "handshake-timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  async disconnectRobot(sessionId: string): Promise<void> {
    await this.requireSession(sessionId).disconnect();
    this.notify();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.disconnect()));
    this.stopHeartbeatIfIdle();
    this.notify();
  }

  async sendToRobot(robotId: number, message: MultiAgentMessage): Promise<void> {
    const session = this.getSessionByRobotId(robotId);
    if (!session || session.state !== "ready") throw new Error(`Target robot ${robotId} is not ready.`);
    if (message.targetRobotId !== robotId) throw new Error("Message target does not match the selected robot.");
    await session.send(message);
  }

  async publish(request: PublishRequest): Promise<void> {
    const session = this.getSessionByRobotId(request.targetRobotId);
    if (!session || session.state !== "ready") throw new Error(`Target robot ${request.targetRobotId} is offline.`);
    const flags = this.flagsForRequest(request);
    const message: MultiAgentMessage = {
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.DATA,
      flags,
      sourceRobotId: LAPTOP_COORDINATOR_ID,
      targetRobotId: request.targetRobotId,
      sequence: session.nextSequence(),
      topicId: request.topicId,
      ttlMilliseconds: request.ttlMs,
      applicationPayload: request.payload,
    };
    await session.send(message);
    this.logMessage(message, "sent");
  }

  /** Compatibility entry point for features that intentionally target one selected fleet robot. */
  async publishToActiveRobot(
    request: Omit<PublishRequest, "targetRobotId">,
  ): Promise<void> {
    if (this.activeLegacyRobotId === null) throw new Error("No active fleet robot is selected.");
    await this.publish({ ...request, targetRobotId: this.activeLegacyRobotId });
  }

  async broadcast(
    request: Omit<PublishRequest, "targetRobotId">,
  ): Promise<void> {
    const ready = this.getReadySessions();
    await Promise.all(ready.map(async (session) => {
      const message: MultiAgentMessage = {
        protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
        messageKind: MultiAgentMessageKind.DATA,
        flags: this.flagsForRequest({ ...request, targetRobotId: BROADCAST_ROBOT_ID }),
        sourceRobotId: LAPTOP_COORDINATOR_ID,
        targetRobotId: BROADCAST_ROBOT_ID,
        sequence: session.nextSequence(),
        topicId: request.topicId,
        ttlMilliseconds: request.ttlMs,
        applicationPayload: request.payload,
      };
      await session.send(message);
      this.logMessage(message, `broadcast-copy:${session.robotId}`);
    }));
  }

  async ping(robotId: number): Promise<void> {
    const session = this.getSessionByRobotId(robotId);
    if (!session || session.state !== "ready") throw new Error(`Robot ${robotId} is not ready.`);
    const sequence = session.nextSequence();
    const payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, sequence, true);
    this.pingStartedAt.set(`${session.sessionId}:${sequence}`, monotonicNow());
    await session.send({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.PING,
      flags: 0,
      sourceRobotId: LAPTOP_COORDINATOR_ID,
      targetRobotId: robotId,
      sequence,
      topicId: 0,
      ttlMilliseconds: 2000,
      applicationPayload: payload,
    });
  }

  setActiveLegacyRobot(robotId: number | null): void {
    if (robotId !== null && !this.robotIds.has(robotId)) throw new Error(`Unknown robot ${robotId}.`);
    this.activeLegacyRobotId = robotId;
    this.notify();
  }

  renameRobot(sessionId: string, alias: string): void {
    const trimmed = alias.trim();
    if (!trimmed) throw new Error("Robot alias cannot be empty.");
    const session = this.requireSession(sessionId);
    session.alias = trimmed.slice(0, 40);
    this.persistSession(session);
    void this.broadcastTeamDirectory();
    this.notify();
  }

  getSessionByRobotId(robotId: number): RobotSession | undefined {
    return this.robotIds.get(robotId);
  }

  getReadySessions(): RobotSession[] {
    return [...this.sessions.values()].filter((session) => session.state === "ready");
  }

  getSessions(): RobotSession[] {
    return [...this.sessions.values()];
  }

  onTopic(topicId: number, listener: TopicListener): () => void {
    const listeners = this.topicListeners.get(topicId) ?? new Set<TopicListener>();
    listeners.add(listener);
    this.topicListeners.set(topicId, listeners);
    return () => listeners.delete(listener);
  }

  subscribe(listener: (snapshot: FleetSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => this.subscribers.delete(listener);
  }

  snapshot(): FleetSnapshot {
    return {
      sessions: [...this.sessions.values()].map((session): RobotSessionSnapshot => ({
        sessionId: session.sessionId,
        robotId: session.robotId,
        hardwareIdentity: session.hardwareIdentity,
        alias: session.alias,
        deviceName: session.transport.deviceName,
        browserIdentity: session.transport.browserIdentity,
        state: session.state,
        health: session.getHealth(),
        capabilities: session.capabilities,
        metrics: { ...session.metrics },
        activeLegacyRobot: session.robotId === this.activeLegacyRobotId,
      })),
      routingLog: [...this.routingLog],
      activeLegacyRobotId: this.activeLegacyRobotId,
    };
  }

  private async handleIncoming(
    session: RobotSession,
    message: MultiAgentMessage,
    arrivedAt: number,
  ): Promise<void> {
    if (message.messageKind === MultiAgentMessageKind.HELLO) {
      await this.handleHello(session, message);
      return;
    }
    if (session.state !== "ready" || session.robotId === undefined) return;
    if (message.sourceRobotId !== session.robotId) {
      session.metrics.invalidPackets += 1;
      this.logMessage(message, "rejected-source-impersonation");
      return;
    }
    const ageMs = monotonicNow() - arrivedAt;
    if (message.ttlMilliseconds > 0 && ageMs > message.ttlMilliseconds) {
      session.metrics.stalePackets += 1;
      this.logMessage(message, "stale-on-arrival");
      return;
    }
    const duplicateKey = `${message.sourceRobotId}:${message.sequence}`;
    if (this.recentMessages.has(duplicateKey)) {
      session.metrics.duplicatePackets += 1;
      this.logMessage(message, "duplicate");
      return;
    }
    this.rememberMessage(duplicateKey, arrivedAt);

    if (message.messageKind === MultiAgentMessageKind.ACK) {
      this.handleAcknowledgement(session, message);
    }
    if (message.targetRobotId === LAPTOP_COORDINATOR_ID) {
      await this.consumeLaptopMessage(session, message);
      return;
    }
    if ((message.flags & MultiAgentFlag.RELAYED) !== 0) {
      this.logMessage(message, "relay-loop-blocked");
      return;
    }
    if (message.targetRobotId === BROADCAST_ROBOT_ID) {
      const targets = this.getReadySessions().filter((target) => target.sessionId !== session.sessionId);
      await Promise.all(targets.map((target) => this.forward(target, message)));
      return;
    }
    const target = this.getSessionByRobotId(message.targetRobotId);
    if (!target || target.state !== "ready") {
      this.logMessage(message, "target-offline");
      await this.sendError(session, message, "target offline");
      return;
    }
    await this.forward(target, message);
  }

  private async handleHello(session: RobotSession, message: MultiAgentMessage): Promise<void> {
    if (message.sourceRobotId !== UNASSIGNED_ROBOT_ID || message.targetRobotId !== LAPTOP_COORDINATOR_ID) {
      session.metrics.invalidPackets += 1;
      return;
    }
    try {
      const capabilities = decodeHelloPayload(message.applicationPayload);
      if (capabilities.protocolVersion !== MULTI_AGENT_PROTOCOL_VERSION) throw new Error("Incompatible protocol version.");
      if (session.hardwareIdentity && session.hardwareIdentity !== capabilities.hardwareIdentity) {
        throw new Error("Robot hardware identity changed within one physical session.");
      }
      const robotId = this.assignRobotId(capabilities.hardwareIdentity, session);
      const stored = this.readStoredRobots()[capabilities.hardwareIdentity];
      if (stored?.alias && !this.preferProvidedAlias.has(session.sessionId)) session.alias = stored.alias;
      await session.send({
        protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
        messageKind: MultiAgentMessageKind.HELLO_ACK,
        flags: 0,
        sourceRobotId: LAPTOP_COORDINATOR_ID,
        targetRobotId: robotId,
        sequence: session.nextSequence(),
        topicId: 0,
        ttlMilliseconds: 5000,
        applicationPayload: encodeHelloAckPayload(robotId, HEARTBEAT_INTERVAL_MS),
      });
      session.markReady(robotId, capabilities);
      session.metrics.lastHeartbeatAt = Date.now();
      this.robotIds.set(robotId, session);
      this.persistSession(session);
      if (this.activeLegacyRobotId === null) this.activeLegacyRobotId = robotId;
      this.ensureHeartbeatTimer();
      this.log(UNASSIGNED_ROBOT_ID, robotId, 0, message.sequence, "handshake-ready");
      this.notify();
      // HELLO is also a periodic identity refresh. Re-publishing the directory
      // lets a robot recover if its first alias announcement was missed.
      await this.broadcastTeamDirectory();
    } catch {
      session.metrics.invalidPackets += 1;
      session.markError();
    }
  }

  private async consumeLaptopMessage(session: RobotSession, message: MultiAgentMessage): Promise<void> {
    if (message.messageKind === MultiAgentMessageKind.PING) {
      await session.send({
        ...message,
        messageKind: MultiAgentMessageKind.PONG,
        sourceRobotId: LAPTOP_COORDINATOR_ID,
        targetRobotId: session.robotId!,
        sequence: session.nextSequence(),
        flags: 0,
      });
      return;
    }
    if (message.messageKind === MultiAgentMessageKind.PONG) {
      const pingSequence = message.applicationPayload.length >= 2
        ? new DataView(message.applicationPayload.buffer, message.applicationPayload.byteOffset).getUint16(0, true)
        : message.sequence;
      const key = `${session.sessionId}:${pingSequence}`;
      const startedAt = this.pingStartedAt.get(key);
      if (startedAt !== undefined) {
        const rtt = monotonicNow() - startedAt;
        this.pingStartedAt.delete(key);
        this.rttTrackers.get(session.sessionId)?.add(rtt, session.metrics);
        this.logMessage(message, "pong", rtt);
      }
      return;
    }
    if (message.messageKind === MultiAgentMessageKind.HEARTBEAT) {
      session.metrics.lastHeartbeatAt = Date.now();
      return;
    }
    if (message.messageKind === MultiAgentMessageKind.DATA) {
      if ((message.flags & MultiAgentFlag.ACK_REQUIRED) !== 0) await this.sendAck(session, message);
      const listeners = this.topicListeners.get(message.topicId);
      if (listeners) for (const listener of listeners) listener(message);
      this.logMessage(message, "consumed-by-laptop");
    }
  }

  private async forward(target: RobotSession, message: MultiAgentMessage): Promise<void> {
    const forwarded = { ...message, flags: message.flags | MultiAgentFlag.RELAYED };
    try {
      await target.send(forwarded);
      this.logMessage(forwarded, "relayed");
    } catch {
      this.logMessage(forwarded, "relay-failed");
    }
  }

  private async sendAck(session: RobotSession, original: MultiAgentMessage): Promise<void> {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, original.sourceRobotId, true);
    view.setUint16(2, original.sequence, true);
    await session.send({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.ACK,
      flags: 0,
      sourceRobotId: LAPTOP_COORDINATOR_ID,
      targetRobotId: original.sourceRobotId,
      sequence: session.nextSequence(),
      topicId: original.topicId,
      ttlMilliseconds: 2000,
      applicationPayload: payload,
    });
  }

  private handleAcknowledgement(session: RobotSession, message: MultiAgentMessage): void {
    if (message.applicationPayload.length !== 4) {
      session.metrics.invalidPackets += 1;
      return;
    }
    const view = new DataView(message.applicationPayload.buffer, message.applicationPayload.byteOffset);
    session.acknowledge(view.getUint16(0, true), view.getUint16(2, true));
  }

  private async sendError(session: RobotSession, original: MultiAgentMessage, detail: string): Promise<void> {
    const payload = new TextEncoder().encode(detail).slice(0, 80);
    await session.send({
      protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
      messageKind: MultiAgentMessageKind.ERROR,
      flags: 0,
      sourceRobotId: LAPTOP_COORDINATOR_ID,
      targetRobotId: original.sourceRobotId,
      sequence: session.nextSequence(),
      topicId: original.topicId,
      ttlMilliseconds: 2000,
      applicationPayload: payload,
    });
  }

  private ensureHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      for (const session of this.getReadySessions()) {
        if (Date.now() - session.metrics.lastHeartbeatAt > ROBOT_HEARTBEAT_TIMEOUT_MS) {
          session.markError();
          this.log(
            session.robotId ?? UNASSIGNED_ROBOT_ID,
            LAPTOP_COORDINATOR_ID,
            0,
            0,
            "robot-heartbeat-timeout",
          );
          continue;
        }
        const message: MultiAgentMessage = {
          protocolVersion: MULTI_AGENT_PROTOCOL_VERSION,
          messageKind: MultiAgentMessageKind.HEARTBEAT,
          flags: 0,
          sourceRobotId: LAPTOP_COORDINATOR_ID,
          targetRobotId: session.robotId!,
          sequence: session.nextSequence(),
          topicId: 0,
          ttlMilliseconds: 3000,
          applicationPayload: new Uint8Array(0),
        };
        void session.send(message).catch(() => undefined);
        void this.ping(session.robotId!).catch(() => undefined);
      }
      this.notify();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async broadcastTeamDirectory(): Promise<void> {
    const ready = this.getReadySessions();
    if (ready.length === 0) return;
    const entries = ready.flatMap((listed) => {
      if (listed.robotId === undefined) return [];
      const alias = this.encodeDirectoryAlias(listed.alias);
      return [{ robotId: listed.robotId, alias }];
    });
    const chunks: typeof entries[] = [];
    let current: typeof entries = [];
    let currentLength = 1;
    for (const entry of entries) {
      const entryLength = 3 + entry.alias.length;
      if (current.length > 0 && currentLength + entryLength > 220) {
        chunks.push(current);
        current = [];
        currentLength = 1;
      }
      current.push(entry);
      currentLength += entryLength;
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const payloadLength = 1 + chunk.reduce((total, entry) => total + 3 + entry.alias.length, 0);
      const payload = new Uint8Array(payloadLength);
      const view = new DataView(payload.buffer);
      payload[0] = chunk.length;
      let offset = 1;
      for (const entry of chunk) {
        view.setUint16(offset, entry.robotId, true);
        payload[offset + 2] = entry.alias.length;
        payload.set(entry.alias, offset + 3);
        offset += 3 + entry.alias.length;
      }
      await this.broadcast({
        topicId: MultiAgentTopic.TEAM_DIRECTORY,
        payload,
        qos: chunks.length === 1 ? 'latest' : 'normal',
        ttlMs: 3000,
      }).catch(() => undefined);
    }
  }

  private encodeDirectoryAlias(alias: string): Uint8Array {
    const encoder = new TextEncoder();
    let normalized = alias.trim();
    while (normalized && encoder.encode(normalized).length > 32) {
      normalized = normalized.slice(0, -1);
    }
    return encoder.encode(normalized || 'XRP');
  }

  private stopHeartbeatIfIdle(): void {
    if (this.sessions.size > 0 || this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private flagsForRequest(request: PublishRequest): number {
    let flags = request.highPriority || request.topicId === MultiAgentTopic.EMERGENCY_STOP
      ? MultiAgentFlag.HIGH_PRIORITY
      : 0;
    if (request.qos === "latest") flags |= MultiAgentFlag.LATEST_ONLY;
    if (request.qos === "reliable") flags |= MultiAgentFlag.ACK_REQUIRED;
    return flags;
  }

  private assignRobotId(hardwareIdentity: string, session: RobotSession): number {
    if (
      session.robotId !== undefined &&
      this.robotIds.get(session.robotId) === session
    ) return session.robotId;
    const stored = this.readStoredRobots()[hardwareIdentity];
    if (stored && !this.robotIds.has(stored.robotId)) return stored.robotId;
    while (this.robotIds.has(this.nextRobotId) && this.nextRobotId <= MAX_ASSIGNED_ROBOT_ID) {
      this.nextRobotId += 1;
    }
    if (this.nextRobotId > MAX_ASSIGNED_ROBOT_ID) throw new Error("No robot routing IDs remain.");
    return this.nextRobotId++;
  }

  private persistSession(session: RobotSession): void {
    if (!session.hardwareIdentity || session.robotId === undefined || typeof localStorage === "undefined") return;
    const stored = this.readStoredRobots();
    stored[session.hardwareIdentity] = { robotId: session.robotId, alias: session.alias };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }

  private readStoredRobots(): Record<string, StoredRobot> {
    if (typeof localStorage === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, StoredRobot>;
    } catch {
      return {};
    }
  }

  private rememberMessage(key: string, arrivedAt: number): void {
    this.recentMessages.set(key, arrivedAt);
    while (this.recentMessages.size > MAX_RECENT_MESSAGES) {
      const oldest = this.recentMessages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recentMessages.delete(oldest);
    }
  }

  private forgetRecentMessagesFrom(robotId: number): void {
    const prefix = `${robotId}:`;
    for (const key of this.recentMessages.keys()) {
      if (key.startsWith(prefix)) this.recentMessages.delete(key);
    }
  }

  private logMessage(message: MultiAgentMessage, status: string, rttMs?: number): void {
    this.log(
      message.sourceRobotId,
      message.targetRobotId,
      message.topicId,
      message.sequence,
      status,
      rttMs,
    );
  }

  private log(
    sourceRobotId: number,
    targetRobotId: number,
    topicId: number,
    sequence: number,
    status: string,
    rttMs?: number,
  ): void {
    const entry: RoutingLogEntry = {
      id: this.logId++,
      time: Date.now(),
      sourceRobotId,
      targetRobotId,
      topicId,
      sequence,
      status,
    };
    if (rttMs !== undefined) entry.rttMs = rttMs;
    this.routingLog.unshift(entry);
    if (this.routingLog.length > MAX_ROUTING_LOG) this.routingLog.length = MAX_ROUTING_LOG;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private requireSession(sessionId: string): RobotSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown fleet session ${sessionId}.`);
    return session;
  }

  private createSessionId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `fleet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

let sharedFleetManager: RobotFleetManager | undefined;

export function getRobotFleetManager(): RobotFleetManager {
  if (!sharedFleetManager) sharedFleetManager = new RobotFleetManager();
  return sharedFleetManager;
}
