/**
 * In-memory registry of browser handles and in-flight calls.
 *
 * One entry per browser handle. The entry owns the live WebSocket to the
 * extension (or null while disconnected) and the pending-request map that
 * correlates bridge responses by message id.
 *
 * The relay never retries a call - a retried `click` double-clicks.
 * Transient-failure retries belong to the agent-side client.
 */
import type { WebSocket } from 'ws';
import {
  createRequest,
  WS_CLOSE_SUPERSEDED,
  PROTOCOL_VERSION,
} from '@browserhandle/protocol';
import type {
  BridgeMessage,
  BridgeMethod,
  HandleInfo,
  HandleMeta,
  RegisterMessage,
} from '@browserhandle/protocol';
import type { Logger } from './logger.js';

/** Maximum concurrent in-flight calls per handle (cheap OOM guard) */
export const MAX_PENDING_PER_HANDLE = 100;

/** Disconnected handles are forgotten after this long */
export const TOMBSTONE_TTL_MS = 15 * 60_000;

/** Relay-level call failure with a protocol error code */
export class RelayCallError extends Error {
  constructor(
    public readonly code:
      | 'HANDLE_NOT_FOUND'
      | 'HANDLE_DISCONNECTED'
      | 'RELAY_TIMEOUT'
      | 'RELAY_BUSY',
    message: string
  ) {
    super(message);
    this.name = 'RelayCallError';
  }
}

interface PendingCall {
  resolve: (message: BridgeMessage) => void;
  reject: (error: RelayCallError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HandleEntry {
  handleId: string;
  socket: WebSocket | null;
  name: string;
  protocolVersion: number;
  meta?: HandleMeta;
  connectedAt: number;
  lastSeenAt: number;
  pending: Map<string, PendingCall>;
}

export class HandleRegistry {
  private handles = new Map<string, HandleEntry>();

  constructor(private log: Logger) {}

  /**
   * Register a handle for a newly authenticated socket.
   * A live socket for the same handleId is superseded: its pending calls
   * are rejected and it is closed with WS_CLOSE_SUPERSEDED.
   */
  register(message: RegisterMessage, ws: WebSocket): void {
    const existing = this.handles.get(message.handleId);
    if (existing?.socket && existing.socket !== ws) {
      this.rejectAllPending(existing, 'Superseded by a new connection for this handle');
      const oldSocket = existing.socket;
      existing.socket = null;
      oldSocket.close(WS_CLOSE_SUPERSEDED, 'Superseded by a new connection');
      this.log.info('browser_superseded', { handleId: message.handleId });
    }

    const now = Date.now();
    this.handles.set(message.handleId, {
      handleId: message.handleId,
      socket: ws,
      name: message.name ?? 'Browser',
      protocolVersion: message.protocolVersion,
      meta: message.meta,
      connectedAt: now,
      lastSeenAt: now,
      pending: existing?.pending ?? new Map(),
    });
  }

  /**
   * Mark a handle disconnected. No-op unless `ws` is still the entry's
   * current socket (supersede-safe).
   */
  markDisconnected(handleId: string, ws: WebSocket): void {
    const entry = this.handles.get(handleId);
    if (!entry || entry.socket !== ws) return;
    entry.socket = null;
    entry.lastSeenAt = Date.now();
    this.rejectAllPending(entry, 'Browser handle disconnected');
  }

  /** Bump lastSeenAt (heartbeat pongs, acks) */
  touch(handleId: string): void {
    const entry = this.handles.get(handleId);
    if (entry) entry.lastSeenAt = Date.now();
  }

  /** Correlate a bridge response/error from the extension to its caller */
  resolve(handleId: string, message: BridgeMessage): void {
    const entry = this.handles.get(handleId);
    if (!entry) return;
    entry.lastSeenAt = Date.now();
    const pending = entry.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      entry.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  list(): HandleInfo[] {
    return Array.from(this.handles.values()).map((entry) => ({
      handleId: entry.handleId,
      name: entry.name,
      connected: entry.socket !== null,
      connectedAt: new Date(entry.connectedAt).toISOString(),
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
      protocolVersion: entry.protocolVersion,
      meta: entry.meta,
    }));
  }

  counts(): { connected: number; total: number } {
    let connected = 0;
    for (const entry of this.handles.values()) {
      if (entry.socket !== null) connected++;
    }
    return { connected, total: this.handles.size };
  }

  /**
   * Send a bridge request to a handle and await its response or error.
   *
   * The relay generates a fresh envelope id - agent-supplied ids are never
   * trusted, which makes concurrent agents per handle safe by construction.
   */
  call(
    handleId: string,
    method: BridgeMethod,
    payload: unknown,
    timeoutMs: number
  ): Promise<BridgeMessage> {
    const entry = this.handles.get(handleId);
    if (!entry) {
      return Promise.reject(
        new RelayCallError('HANDLE_NOT_FOUND', `No handle registered with id ${handleId}`)
      );
    }
    if (!entry.socket || entry.socket.readyState !== entry.socket.OPEN) {
      return Promise.reject(
        new RelayCallError('HANDLE_DISCONNECTED', `Handle ${handleId} is not connected`)
      );
    }
    if (entry.pending.size >= MAX_PENDING_PER_HANDLE) {
      return Promise.reject(
        new RelayCallError(
          'RELAY_BUSY',
          `Handle ${handleId} already has ${entry.pending.size} calls in flight`
        )
      );
    }

    const request = createRequest(method, payload);
    return new Promise<BridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(request.id);
        reject(
          new RelayCallError('RELAY_TIMEOUT', `${method} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      entry.pending.set(request.id, { resolve, reject, timer });
      entry.socket!.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(timer);
          if (entry.pending.delete(request.id)) {
            reject(
              new RelayCallError('HANDLE_DISCONNECTED', `Failed to send to handle: ${err.message}`)
            );
          }
        }
      });
    });
  }

  /** Drop disconnected entries whose tombstone has expired */
  prune(ttlMs = TOMBSTONE_TTL_MS): void {
    const cutoff = Date.now() - ttlMs;
    for (const [handleId, entry] of this.handles) {
      if (entry.socket === null && entry.lastSeenAt < cutoff) {
        this.handles.delete(handleId);
        this.log.debug('handle_pruned', { handleId });
      }
    }
  }

  /** Reject everything and close all sockets (relay shutdown) */
  closeAll(): void {
    for (const entry of this.handles.values()) {
      this.rejectAllPending(entry, 'Relay shutting down');
      entry.socket?.close(1001, 'Relay shutting down');
      entry.socket = null;
    }
    this.handles.clear();
  }

  private rejectAllPending(entry: HandleEntry, reason: string): void {
    for (const [id, pending] of entry.pending) {
      clearTimeout(pending.timer);
      entry.pending.delete(id);
      pending.reject(new RelayCallError('HANDLE_DISCONNECTED', reason));
    }
  }
}

/** Default protocol version accepted by this relay build */
export const ACCEPTED_PROTOCOL_VERSION = PROTOCOL_VERSION;
