/**
 * Agent-facing HTTP API.
 *
 *   GET  /healthz                  - liveness, no auth, leaks no handle ids
 *   GET  /v1/handles               - list registered handles (Bearer auth)
 *   POST /v1/handles/:id/call      - invoke a bridge method on a handle (Bearer auth)
 *
 * Relay-level failures map to real HTTP status codes. Any answer from the
 * extension - including bridge errors like STALE_SNAPSHOT - is a successful
 * relay operation and returns 200 with the CallResponse envelope.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { callRequestSchema, OPERATION_TIMEOUTS } from '@browserhandle/protocol';
import type { CallResponse, HealthInfo } from '@browserhandle/protocol';
import { agentAuthorized } from './auth.js';
import type { AuthConfig } from './auth.js';
import { HandleRegistry, RelayCallError } from './registry.js';
import type { Logger } from './logger.js';
import { RELAY_VERSION } from './version.js';

/** Hard cap on a single call's timeout */
export const MAX_CALL_TIMEOUT_MS = 120_000;

/** Default when a method has no entry in OPERATION_TIMEOUTS */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Request body limit (covers dropFiles base64 payloads) */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const RELAY_ERROR_STATUS: Record<RelayCallError['code'], number> = {
  HANDLE_NOT_FOUND: 404,
  HANDLE_DISCONNECTED: 503,
  RELAY_TIMEOUT: 504,
  RELAY_BUSY: 429,
};

export interface HttpApiDeps {
  registry: HandleRegistry;
  auth: AuthConfig;
  log: Logger;
  startedAt: number;
}

export function createHttpHandler(deps: HttpApiDeps) {
  const { registry, auth, log, startedAt } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      const body: HealthInfo = {
        ok: true,
        version: RELAY_VERSION,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        handles: registry.counts(),
      };
      sendJson(res, 200, body);
      return;
    }

    if (path.startsWith('/v1/')) {
      if (!agentAuthorized(auth, req.headers.authorization)) {
        log.warn('auth_failed', { surface: 'agent', remoteAddr: req.socket.remoteAddress });
        sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
        return;
      }
    }

    if (req.method === 'GET' && path === '/v1/handles') {
      sendJson(res, 200, registry.list());
      return;
    }

    const callMatch = /^\/v1\/handles\/([^/]+)\/call$/.exec(path);
    if (req.method === 'POST' && callMatch) {
      await handleCall(decodeURIComponent(callMatch[1]), req, res);
      return;
    }

    sendError(res, 404, 'INVALID_REQUEST', `No route for ${req.method} ${path}`);
  };

  async function handleCall(
    handleId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      sendError(res, 413, 'INVALID_REQUEST', err instanceof Error ? err.message : 'Body too large');
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      sendError(res, 400, 'INVALID_REQUEST', 'Request body is not valid JSON');
      return;
    }

    const parsed = callRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', `Invalid call request: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
      return;
    }

    const { method, payload, timeoutMs } = parsed.data;
    const effectiveTimeout = Math.min(
      timeoutMs ?? OPERATION_TIMEOUTS[method] ?? DEFAULT_CALL_TIMEOUT_MS,
      MAX_CALL_TIMEOUT_MS
    );

    const start = Date.now();
    try {
      const message = await registry.call(handleId, method, payload ?? {}, effectiveTimeout);
      const durationMs = Date.now() - start;

      if (message.type === 'error') {
        const errPayload = (message.payload ?? {}) as { code?: string; message?: string; details?: unknown };
        log.info('call', { handleId, method, durationMs, outcome: errPayload.code ?? 'error' });
        const body: CallResponse = {
          ok: false,
          error: {
            code: errPayload.code ?? 'HANDLER_ERROR',
            message: errPayload.message ?? 'Bridge error',
            details: errPayload.details,
          },
        };
        sendJson(res, 200, body);
        return;
      }

      log.info('call', { handleId, method, durationMs, outcome: 'ok' });
      const body: CallResponse = { ok: true, result: message.payload };
      sendJson(res, 200, body);
    } catch (err) {
      const durationMs = Date.now() - start;
      if (err instanceof RelayCallError) {
        log.info('call', { handleId, method, durationMs, outcome: err.code });
        sendError(res, RELAY_ERROR_STATUS[err.code], err.code, err.message);
        return;
      }
      log.error('call_failed', {
        handleId,
        method,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, 'HANDLER_ERROR', 'Internal relay error');
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: CallResponse = { ok: false, error: { code, message } };
  sendJson(res, status, body);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      // Reject before buffering an over-limit chunk. Pause (not destroy) the
      // request so the caller's 413 response can still be written and flushed;
      // Node closes the connection once the response ends on an undrained body.
      if (total + chunk.length > maxBytes) {
        aborted = true;
        req.pause();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      total += chunk.length;
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}
