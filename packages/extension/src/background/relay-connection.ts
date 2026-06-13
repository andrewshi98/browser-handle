/**
 * Single connection from the extension to a configured relay.
 *
 * Replaces the old ten-socket localhost dialer. State machine:
 *   idle -> connecting -> registering -> ready
 *                              |            |
 *                              +--> backoff <+  (reconnect with jitter)
 *                              +--> auth-error  (4401: slow retry)
 *
 * Once ready, bridge request handling is identical to the old ws-bridge:
 * ack immediately, route through MessageRouter, send the response.
 */
import {
  PROTOCOL_VERSION,
  isBridgeMessage,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_SUPERSEDED,
} from '@browserhandle/protocol';
import type {
  BridgeMessage,
  BridgeRequest,
  RegisterMessage,
  RegisteredMessage,
  RelayErrorMessage,
} from '@browserhandle/protocol';
import type { MessageRouter } from './message-router';
import type { RelayConfig } from './connection-config';

export type ConnectionState =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'registering'
  | 'ready'
  | 'backoff'
  | 'auth-error';

export interface RelayConnectionStatus {
  state: ConnectionState;
  handleId: string;
  relayUrl: string;
  detail?: string;
}

const REGISTER_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const AUTH_RETRY_MS = 60_000;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private detail?: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private registerTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffAttempt = 0;
  private disposed = false;

  constructor(
    private config: RelayConfig,
    private readonly handleId: string,
    private readonly router: MessageRouter,
    private readonly onStatus?: (status: RelayConnectionStatus) => void
  ) {}

  /** Begin connecting (or go to 'disabled' when the config is disabled). */
  start(): void {
    this.disposed = false;
    if (!this.config.enabled) {
      this.setState('disabled');
      return;
    }
    this.connect();
  }

  /** Tear down permanently. */
  stop(): void {
    this.disposed = true;
    this.clearTimers();
    this.closeSocket();
    this.setState('idle');
  }

  /** Apply a new config: redial from scratch. */
  updateConfig(config: RelayConfig): void {
    this.config = config;
    this.clearTimers();
    this.closeSocket();
    this.backoffAttempt = 0;
    this.start();
  }

  getStatus(): RelayConnectionStatus {
    return {
      state: this.state,
      handleId: this.handleId,
      relayUrl: this.config.relayUrl,
      detail: this.detail,
    };
  }

  isReady(): boolean {
    return this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.disposed) return;
    this.setState('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.config.relayUrl);
    } catch (err) {
      this.detail = err instanceof Error ? err.message : 'Invalid relay URL';
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.setState('registering');
      this.sendRegister(ws);
      this.registerTimer = setTimeout(() => {
        if (this.ws === ws && this.state === 'registering') {
          this.detail = 'Relay did not confirm registration';
          ws.close();
        }
      }, REGISTER_TIMEOUT_MS);
    });

    ws.addEventListener('message', (event) => {
      if (this.ws === ws) this.handleMessage(ws, event.data);
    });

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearRegisterTimer();
      this.handleClose(event.code);
    });

    ws.addEventListener('error', () => {
      // 'error' is always followed by 'close', where reconnect is decided.
    });
  }

  private sendRegister(ws: WebSocket): void {
    const message: RegisterMessage = {
      type: 'register',
      protocolVersion: PROTOCOL_VERSION,
      handleId: this.handleId,
      token: this.config.token,
      name: this.config.name,
      meta: {
        extensionVersion: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
      },
    };
    this.rawSend(ws, message);
  }

  private handleMessage(ws: WebSocket, data: unknown): void {
    let message: unknown;
    try {
      message = typeof data === 'string' ? JSON.parse(data) : null;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    const type = (message as { type?: string }).type;

    if (type === 'registered') {
      const reg = message as RegisteredMessage;
      this.clearRegisterTimer();
      this.backoffAttempt = 0;
      this.detail = `relay ${reg.relayVersion}`;
      this.setState('ready');
      return;
    }

    if (type === 'relay-error') {
      const err = message as RelayErrorMessage;
      this.detail = `${err.code}: ${err.message}`;
      // The relay closes the socket after this; handleClose decides retry.
      return;
    }

    if (isBridgeMessage(message) && message.type === 'request') {
      void this.handleRequest(ws, message as BridgeRequest);
    }
  }

  private async handleRequest(ws: WebSocket, request: BridgeRequest): Promise<void> {
    // Ack immediately so the relay sees liveness.
    this.rawSend(ws, {
      id: request.id,
      type: 'ack',
      method: request.method,
      payload: {},
      timestamp: Date.now(),
    });

    try {
      const response = await this.router.handleBridgeRequest(request);
      this.rawSend(ws, response);
    } catch (err) {
      this.rawSend(ws, {
        id: request.id,
        type: 'error',
        method: request.method,
        payload: {
          code: 'HANDLER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
    }
  }

  private handleClose(code: number): void {
    if (this.disposed) return;

    if (code === WS_CLOSE_UNAUTHORIZED) {
      // Bad token: stop hammering. Retry slowly until the config changes.
      this.setState('auth-error');
      this.scheduleReconnect(AUTH_RETRY_MS);
      return;
    }

    if (code === WS_CLOSE_SUPERSEDED) {
      // Another live connection owns this handle (likely a zombie SW race).
      // Do not reconnect; a later service-worker start will re-register.
      this.detail = 'Superseded by another connection';
      this.setState('idle');
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(fixedDelayMs?: number): void {
    if (this.disposed || this.reconnectTimer) return;
    if (this.state !== 'auth-error') this.setState('backoff');

    const delay = fixedDelayMs ?? this.nextBackoffDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private nextBackoffDelay(): number {
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** this.backoffAttempt, BACKOFF_CAP_MS);
    this.backoffAttempt++;
    // Full jitter in [exp/2, exp].
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  private rawSend(ws: WebSocket, message: BridgeMessage | RegisterMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket closing; close handler will reconnect
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onStatus?.(this.getStatus());
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearRegisterTimer();
  }

  private clearRegisterTimer(): void {
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }
}
