/**
 * BrowserHandleClient - the agent-facing HTTP client for a relay.
 *
 * This is "the BrowserHandle API": list handles and call bridge methods on
 * a handle. Identical whether the relay is local or remote - only the URL
 * differs. Zero runtime dependencies (global fetch, Node 20+).
 *
 * Transient failures (network errors, 503, 504, 429) are retried with
 * exponential backoff. Definitive answers - 401/404/400 and any 200
 * ok:false bridge error - are returned immediately without retry.
 */
import {
  OPERATION_TIMEOUTS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from '@browserhandle/protocol';
import type {
  BridgeMethod,
  CallRequest,
  CallResponse,
  HandleInfo,
  HealthInfo,
} from '@browserhandle/protocol';

export interface BrowserHandleClientOptions {
  /** Relay base URL, e.g. http://127.0.0.1:18080 or https://relay.example.com */
  relayUrl: string;
  /** Agent token sent as Authorization: Bearer <token> */
  token?: string;
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max transient retries per call (default MAX_RETRY_ATTEMPTS) */
  maxRetries?: number;
}

/** Buffer added to the relay's per-op timeout before the client aborts */
const FETCH_TIMEOUT_BUFFER_MS = 5_000;
const MAX_FETCH_TIMEOUT_MS = 125_000;

/** HTTP statuses worth retrying (relay-level transient conditions) */
const TRANSIENT_STATUSES = new Set([429, 503, 504]);

export class BrowserHandleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'BrowserHandleError';
  }
}

export class BrowserHandleClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(options: BrowserHandleClientOptions) {
    this.base = options.relayUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? MAX_RETRY_ATTEMPTS;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('global fetch is unavailable; pass fetchImpl or use Node 20+');
    }
  }

  /** Relay liveness. Throws BrowserHandleError on network failure. */
  async health(): Promise<HealthInfo> {
    const res = await this.rawFetch(`${this.base}/healthz`, { method: 'GET' }, 5_000);
    if (!res.ok) {
      throw new BrowserHandleError('RELAY_UNHEALTHY', `Relay health check returned ${res.status}`, res.status);
    }
    return (await res.json()) as HealthInfo;
  }

  /** List handles registered on the relay (connected and tombstoned). */
  async listHandles(): Promise<HandleInfo[]> {
    const res = await this.rawFetch(`${this.base}/v1/handles`, { method: 'GET' }, 10_000);
    if (res.status === 401) {
      throw new BrowserHandleError('UNAUTHORIZED', 'Relay rejected the agent token', 401);
    }
    if (!res.ok) {
      throw new BrowserHandleError('RELAY_ERROR', `GET /v1/handles returned ${res.status}`, res.status);
    }
    return (await res.json()) as HandleInfo[];
  }

  /**
   * Call a bridge method on a handle. Returns the CallResponse envelope.
   * Relay-level failures and bridge errors both surface as { ok: false }.
   */
  async call(
    handleId: string,
    method: BridgeMethod,
    payload: unknown = {},
    opts: { timeoutMs?: number; retries?: number } = {}
  ): Promise<CallResponse> {
    const body: CallRequest = { method, payload };
    if (opts.timeoutMs !== undefined) body.timeoutMs = opts.timeoutMs;

    const opTimeout = opts.timeoutMs ?? OPERATION_TIMEOUTS[method] ?? 60_000;
    const fetchTimeout = Math.min(opTimeout + FETCH_TIMEOUT_BUFFER_MS, MAX_FETCH_TIMEOUT_MS);
    const url = `${this.base}/v1/handles/${encodeURIComponent(handleId)}/call`;
    const maxRetries = opts.retries ?? this.maxRetries;

    let lastError: BrowserHandleError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.rawFetch(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
          fetchTimeout
        );
      } catch (err) {
        // Network-level failure (connection refused, abort) - transient.
        lastError = new BrowserHandleError('CONNECTION_LOST', errorMessage(err));
        if (attempt < maxRetries) {
          await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        return { ok: false, error: { code: lastError.code, message: lastError.message } };
      }

      if (res.status === 200 || !TRANSIENT_STATUSES.has(res.status)) {
        // Definitive: the relay's body is normally a CallResponse envelope.
        // A non-JSON body (e.g. an HTML error page from a proxy) is surfaced
        // as { ok: false } rather than throwing a SyntaxError at the caller.
        const parsed = (await res.json().catch(() => null)) as CallResponse | null;
        if (parsed) return parsed;
        return {
          ok: false,
          error: { code: `HTTP_${res.status}`, message: `Relay returned a non-JSON ${res.status} response` },
        };
      }

      // Transient relay-level status (429/503/504): retry, then surface.
      const parsed = (await res.json().catch(() => null)) as CallResponse | null;
      const code = parsed && !parsed.ok ? parsed.error.code : `HTTP_${res.status}`;
      const message =
        parsed && !parsed.ok ? parsed.error.message : `Relay returned ${res.status}`;
      lastError = new BrowserHandleError(code, message, res.status);
      if (attempt < maxRetries) {
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return { ok: false, error: { code, message } };
    }

    // Unreachable, but keeps the type-checker happy.
    return {
      ok: false,
      error: { code: lastError?.code ?? 'RELAY_ERROR', message: lastError?.message ?? 'Call failed' },
    };
  }

  private rawFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    return this.fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? 'Request to relay timed out' : err.message;
  }
  return String(err);
}

export type { BridgeMethod, CallResponse, HandleInfo, HealthInfo } from '@browserhandle/protocol';
