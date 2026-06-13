/**
 * Per-socket state machine for an extension connection.
 *
 * A fresh socket must send a valid `register` message within the deadline
 * or it is closed with WS_CLOSE_BAD_REGISTER. After registration the socket
 * carries bridge traffic: responses/errors are correlated by the registry,
 * acks only bump liveness.
 *
 * The relay pings every HEARTBEAT_INTERVAL_MS; browser WebSocket clients
 * answer pongs at the protocol level. A missed pong terminates the socket.
 * The pings double as MV3 service-worker keepalive traffic.
 */
import type { WebSocket } from 'ws';
import {
  isBridgeMessage,
  registerMessageSchema,
  PROTOCOL_VERSION,
  WS_CLOSE_BAD_REGISTER,
  WS_CLOSE_UNAUTHORIZED,
} from '@browserhandle/protocol';
import type { RegisteredMessage, RelayErrorMessage } from '@browserhandle/protocol';
import { browserAuthorized } from './auth.js';
import type { AuthConfig } from './auth.js';
import type { HandleRegistry } from './registry.js';
import type { Logger } from './logger.js';
import { RELAY_VERSION } from './version.js';

export const REGISTER_DEADLINE_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const PONG_DEADLINE_MS = 10_000;

export interface BrowserSocketDeps {
  registry: HandleRegistry;
  auth: AuthConfig;
  log: Logger;
  remoteAddr?: string;
}

export function attachBrowserSocket(ws: WebSocket, deps: BrowserSocketDeps): void {
  const { registry, auth, log, remoteAddr } = deps;
  let handleId: string | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  const registerDeadline = setTimeout(() => {
    log.debug('register_timeout', { remoteAddr });
    ws.close(WS_CLOSE_BAD_REGISTER, 'No register message received');
  }, REGISTER_DEADLINE_MS);

  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.ping();
    pongTimer ??= setTimeout(() => {
      log.warn('heartbeat_lost', { handleId, remoteAddr });
      ws.terminate();
    }, PONG_DEADLINE_MS);
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('pong', () => {
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
    if (handleId) registry.touch(handleId);
  });

  ws.on('message', (data) => {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      log.debug('invalid_json', { handleId, remoteAddr });
      return;
    }

    if (handleId === null) {
      handleRegister(message);
      return;
    }

    if (isBridgeMessage(message)) {
      if (message.type === 'ack') {
        registry.touch(handleId);
        return;
      }
      if (message.type === 'response' || message.type === 'error') {
        registry.resolve(handleId, message);
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(registerDeadline);
    clearInterval(heartbeat);
    if (pongTimer) clearTimeout(pongTimer);
    if (handleId !== null) {
      registry.markDisconnected(handleId, ws);
      log.info('browser_disconnected', { handleId, remoteAddr });
    }
  });

  ws.on('error', (err) => {
    log.warn('browser_socket_error', { handleId, remoteAddr, error: err.message });
  });

  function handleRegister(message: unknown): void {
    // A first message has arrived (it parsed as JSON); the register deadline
    // has done its job whether or not validation below succeeds. Clearing it
    // here prevents the deadline from firing a redundant close on the socket
    // we are about to close on a validation failure.
    clearTimeout(registerDeadline);

    const parsed = registerMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendRelayError('INVALID_REQUEST', 'First message must be a valid register message');
      ws.close(WS_CLOSE_BAD_REGISTER, 'Invalid register message');
      return;
    }

    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
      sendRelayError(
        'PROTOCOL_MISMATCH',
        `Relay speaks protocol ${PROTOCOL_VERSION}, extension sent ${parsed.data.protocolVersion}`
      );
      ws.close(WS_CLOSE_BAD_REGISTER, 'Protocol version mismatch');
      return;
    }

    if (!browserAuthorized(auth, parsed.data.token)) {
      log.warn('auth_failed', { surface: 'browser', remoteAddr });
      sendRelayError('UNAUTHORIZED', 'Browser token rejected');
      ws.close(WS_CLOSE_UNAUTHORIZED, 'Unauthorized');
      return;
    }

    handleId = parsed.data.handleId;
    registry.register(parsed.data, ws);

    const reply: RegisteredMessage = {
      type: 'registered',
      handleId,
      protocolVersion: PROTOCOL_VERSION,
      relayVersion: RELAY_VERSION,
    };
    ws.send(JSON.stringify(reply));
    log.info('browser_connected', {
      handleId,
      name: parsed.data.name,
      remoteAddr,
    });
  }

  function sendRelayError(code: RelayErrorMessage['code'], message: string): void {
    const frame: RelayErrorMessage = { type: 'relay-error', code, message };
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // socket already gone
    }
  }
}
