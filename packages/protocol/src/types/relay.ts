/**
 * Relay protocol: messages and types for the browser-handle registry.
 *
 * The extension dials the relay's WebSocket endpoint and registers a
 * browser handle. Agents control handles through the relay's HTTP API.
 *
 * Wire directions:
 * - extension -> relay: RegisterMessage, then BridgeResponse | BridgeError | BridgeAck
 * - relay -> extension: RegisteredMessage | RelayErrorMessage, then BridgeRequest
 */
import type { BridgeMethod } from './bridge.js';

/** Version of the relay <-> extension wire protocol */
export const PROTOCOL_VERSION = 1;

/** WebSocket path the extension connects to */
export const BROWSER_WS_PATH = '/ws/browser';

/** Browser/extension metadata reported at registration */
export interface HandleMeta {
  extensionVersion?: string;
  userAgent?: string;
}

/** First message the extension sends on a new WebSocket connection */
export interface RegisterMessage {
  type: 'register';
  protocolVersion: number;
  /** Stable client-generated UUID, persisted by the extension */
  handleId: string;
  /** Browser token, required when the relay has one configured */
  token?: string;
  /** Human-readable label, e.g. "Work laptop" */
  name?: string;
  meta?: HandleMeta;
}

/** Relay's acceptance reply to a register message */
export interface RegisteredMessage {
  type: 'registered';
  handleId: string;
  protocolVersion: number;
  relayVersion: string;
}

/** Relay-level failure sent before closing the socket */
export interface RelayErrorMessage {
  type: 'relay-error';
  code: 'UNAUTHORIZED' | 'PROTOCOL_MISMATCH' | 'INVALID_REQUEST';
  message: string;
}

/** A registered browser handle, as reported by the agent API */
export interface HandleInfo {
  handleId: string;
  name: string;
  connected: boolean;
  /** ISO 8601 */
  connectedAt: string;
  /** ISO 8601 */
  lastSeenAt: string;
  protocolVersion: number;
  meta?: HandleMeta;
}

/** Body of POST /v1/handles/:id/call */
export interface CallRequest {
  method: BridgeMethod;
  payload?: unknown;
  /** Override the per-operation default; capped by the relay */
  timeoutMs?: number;
}

/**
 * Result of a call. Relay-level failures use real HTTP status codes;
 * any answer from the extension (including bridge errors such as
 * STALE_SNAPSHOT) is a successful relay operation and returns HTTP 200
 * with this envelope.
 */
export type CallResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Health endpoint response */
export interface HealthInfo {
  ok: boolean;
  version: string;
  uptimeSec: number;
  handles: { connected: number; total: number };
}

// WebSocket close codes used by the relay
/** No/invalid register within the deadline, or protocol mismatch */
export const WS_CLOSE_BAD_REGISTER = 4400;
/** Browser token rejected */
export const WS_CLOSE_UNAUTHORIZED = 4401;
/** A newer connection registered the same handleId */
export const WS_CLOSE_SUPERSEDED = 4409;
