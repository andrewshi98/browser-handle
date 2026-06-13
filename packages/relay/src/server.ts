/**
 * Relay server wiring: one node:http server carries both surfaces.
 *
 *   - HTTP routes (agent API) via createHttpHandler
 *   - WebSocket upgrade on BROWSER_WS_PATH (extension connections)
 *
 * WS uses `noServer` + manual upgrade handling (the documented replacement
 * for the deprecated verifyClient option) so both surfaces share one port
 * and rejected upgrades get real HTTP responses.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { BROWSER_WS_PATH } from '@browserhandle/protocol';
import { attachBrowserSocket } from './browser-socket.js';
import { createHttpHandler, MAX_BODY_BYTES } from './http-api.js';
import { HandleRegistry, TOMBSTONE_TTL_MS } from './registry.js';
import { isLoopbackHost } from './auth.js';
import type { AuthConfig } from './auth.js';
import { createLogger, silentLogger } from './logger.js';
import type { Logger, LogLevel } from './logger.js';

/** Default port, kept from the WebClaw lineage */
export const DEFAULT_PORT = 18080;
export const DEFAULT_HOST = '127.0.0.1';

const PRUNE_INTERVAL_MS = 60_000;

/** Origins allowed to open a browser WebSocket (or no Origin header at all) */
const ALLOWED_ORIGIN_SCHEMES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
];

const ALLOWED_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export interface RelayOptions {
  host?: string;
  port?: number;
  auth?: AuthConfig;
  log?: Logger | { level: LogLevel };
}

export interface Relay {
  registry: HandleRegistry;
  httpServer: Server;
  /** Bind and start accepting connections; resolves with the bound address */
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createRelay(options: RelayOptions = {}): Relay {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const auth = options.auth ?? {};
  const log: Logger =
    options.log === undefined
      ? silentLogger
      : 'level' in options.log
        ? createLogger(options.log.level)
        : options.log;

  const registry = new HandleRegistry(log);
  const startedAt = Date.now();
  const httpHandler = createHttpHandler({ registry, auth, log, startedAt });

  const httpServer = createServer((req, res) => {
    void httpHandler(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    if (path !== BROWSER_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    // Origin check: extension schemes or no Origin (Node clients, tests).
    // Web origins (http/https) are never allowed to claim a browser handle.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGIN_SCHEMES.some((scheme) => origin.startsWith(scheme))) {
      log.warn('upgrade_rejected', { reason: 'origin', origin });
      rejectUpgrade(socket, 403, 'Forbidden: disallowed origin');
      return;
    }

    // DNS-rebinding protection: in tokenless mode the Host header must be
    // loopback. With a browser token configured, the token is the gate.
    if (auth.browserToken === undefined) {
      const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (hostHeader !== '' && !ALLOWED_LOOPBACK_HOSTS.includes(hostHeader)) {
        log.warn('upgrade_rejected', { reason: 'host', host: hostHeader });
        rejectUpgrade(socket, 403, 'Forbidden: disallowed host');
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachBrowserSocket(ws, {
        registry,
        auth,
        log,
        remoteAddr: req.socket.remoteAddress ?? undefined,
      });
    });
  });

  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  return {
    registry,
    httpServer,

    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', reject);
          pruneTimer = setInterval(() => registry.prune(TOMBSTONE_TTL_MS), PRUNE_INTERVAL_MS);
          pruneTimer.unref();
          const address = httpServer.address();
          const boundPort = typeof address === 'object' && address ? address.port : port;
          log.info('relay_started', {
            host,
            port: boundPort,
            authEnabled: {
              browser: auth.browserToken !== undefined,
              agent: auth.agentToken !== undefined,
            },
            loopback: isLoopbackHost(host),
          });
          resolve({ host, port: boundPort });
        });
      });
    },

    close(): Promise<void> {
      if (pruneTimer) clearInterval(pruneTimer);
      registry.closeAll();
      return new Promise((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
          // Force-drop lingering keep-alive / half-open agent connections so
          // close() resolves promptly instead of waiting on idle sockets.
          httpServer.closeAllConnections?.();
        });
      });
    },
  };
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` + 'Connection: close\r\n' + 'Content-Length: 0\r\n\r\n'
  );
  socket.destroy();
}
