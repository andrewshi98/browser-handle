import { describe, it, expect, vi } from 'vitest';
import { BrowserHandleClient, BrowserHandleError } from '../index.js';
import type { CallResponse } from '@browserhandle/protocol';

/** Build a fake fetch that returns a scripted sequence of responses/throws. */
function scriptedFetch(steps: Array<Response | (() => Response | never)>) {
  let i = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (typeof step === 'function') return step();
    // Clone so a reused step yields a fresh, unconsumed body on each retry.
    return step.clone();
  }) as unknown as typeof fetch;
  return { impl, calls, count: () => i };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('health', () => {
  it('returns parsed health info', async () => {
    const { impl } = scriptedFetch([
      jsonResponse(200, { ok: true, version: '0.1.0', uptimeSec: 1, handles: { connected: 0, total: 0 } }),
    ]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    const health = await client.health();
    expect(health.ok).toBe(true);
  });

  it('throws on a non-200 health response', async () => {
    const { impl } = scriptedFetch([jsonResponse(500, {})]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    await expect(client.health()).rejects.toBeInstanceOf(BrowserHandleError);
  });
});

describe('listHandles', () => {
  it('returns the handle array', async () => {
    const handles = [{ handleId: 'h1', name: 'A', connected: true }];
    const { impl } = scriptedFetch([jsonResponse(200, handles)]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    expect(await client.listHandles()).toHaveLength(1);
  });

  it('throws UNAUTHORIZED on 401', async () => {
    const { impl } = scriptedFetch([jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } })]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    await expect(client.listHandles()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('sends the bearer token', async () => {
    const { impl, calls } = scriptedFetch([jsonResponse(200, [])]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', token: 'secret', fetchImpl: impl });
    await client.listHandles();
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('authorization')).toBe('Bearer secret');
  });
});

describe('call', () => {
  it('returns ok:true result on success', async () => {
    const ok: CallResponse = { ok: true, result: { clicked: true } };
    const { impl } = scriptedFetch([jsonResponse(200, ok)]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    const res = await client.call('h1', 'click', { ref: '@e1' });
    expect(res).toEqual(ok);
  });

  it('returns a 200 ok:false bridge error without retrying', async () => {
    const bridgeErr: CallResponse = { ok: false, error: { code: 'STALE_SNAPSHOT', message: 'stale' } };
    const { impl, count } = scriptedFetch([jsonResponse(200, bridgeErr)]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    const res = await client.call('h1', 'click', {});
    expect(res).toEqual(bridgeErr);
    expect(count()).toBe(1); // no retry
  });

  it('does NOT retry a 404 HANDLE_NOT_FOUND', async () => {
    const notFound: CallResponse = { ok: false, error: { code: 'HANDLE_NOT_FOUND', message: 'gone' } };
    const { impl, count } = scriptedFetch([jsonResponse(404, notFound)]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    const res = await client.call('h1', 'ping');
    expect(res).toEqual(notFound);
    expect(count()).toBe(1);
  });

  it('does NOT retry a 401', async () => {
    const unauth: CallResponse = { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } };
    const { impl, count } = scriptedFetch([jsonResponse(401, unauth)]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    await client.call('h1', 'ping');
    expect(count()).toBe(1);
  });

  it('retries a 503 then succeeds', async () => {
    const ok: CallResponse = { ok: true, result: 'done' };
    const { impl, count } = scriptedFetch([
      jsonResponse(503, { ok: false, error: { code: 'HANDLE_DISCONNECTED', message: 'down' } }),
      jsonResponse(200, ok),
    ]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    const res = await client.call('h1', 'ping');
    expect(res).toEqual(ok);
    expect(count()).toBe(2);
  });

  it('surfaces the relay error after exhausting retries on 503', async () => {
    const down: CallResponse = { ok: false, error: { code: 'HANDLE_DISCONNECTED', message: 'down' } };
    const { impl, count } = scriptedFetch([jsonResponse(503, down)]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl, maxRetries: 2 });
    const res = await client.call('h1', 'ping');
    expect(res).toEqual(down);
    expect(count()).toBe(3); // initial + 2 retries
  });

  it('retries a network error then surfaces CONNECTION_LOST', async () => {
    const { impl, count } = scriptedFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl, maxRetries: 1 });
    const res = await client.call('h1', 'ping');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONNECTION_LOST');
    expect(count()).toBe(2);
  });

  it('passes an explicit timeoutMs through in the body', async () => {
    const { impl, calls } = scriptedFetch([jsonResponse(200, { ok: true, result: null })]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r', fetchImpl: impl });
    await client.call('h1', 'evaluate', { expression: '1' }, { timeoutMs: 1234 });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ method: 'evaluate', timeoutMs: 1234 });
  });

  it('url-encodes the handle id', async () => {
    const { impl, calls } = scriptedFetch([jsonResponse(200, { ok: true, result: null })]);
    const client = new BrowserHandleClient({ relayUrl: 'http://r/', fetchImpl: impl });
    await client.call('weird/id', 'ping');
    expect(calls[0].url).toBe('http://r/v1/handles/weird%2Fid/call');
  });
});
