/**
 * Tests for handle binding: auto-bind when exactly one handle is connected,
 * instructive errors otherwise, explicit binding, and CallResponse mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { HandleBinding } from '../handle-binding.js';
import { BrowserHandleError } from '@browserhandle/client';
import type { BrowserHandleClient } from '@browserhandle/client';
import type { CallResponse, HandleInfo } from '@browserhandle/protocol';

function handle(id: string, connected = true): HandleInfo {
  return {
    handleId: id,
    name: id,
    connected,
    connectedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    protocolVersion: 1,
  };
}

function mockClient(opts: {
  handles?: HandleInfo[];
  call?: (id: string, method: string, payload: unknown) => CallResponse | Promise<CallResponse>;
}): { client: BrowserHandleClient; calls: Array<{ id: string; method: string }> } {
  const calls: Array<{ id: string; method: string }> = [];
  const client = {
    listHandles: vi.fn(async () => opts.handles ?? []),
    call: vi.fn(async (id: string, method: string, payload: unknown) => {
      calls.push({ id, method });
      return opts.call ? opts.call(id, method, payload) : ({ ok: true, result: { method } } as CallResponse);
    }),
    health: vi.fn(),
  } as unknown as BrowserHandleClient;
  return { client, calls };
}

describe('HandleBinding auto-bind', () => {
  it('auto-binds when exactly one handle is connected', async () => {
    const { client, calls } = mockClient({ handles: [handle('only')] });
    const binding = new HandleBinding(client);
    const msg = await binding.requestWithRetry('ping');
    expect(msg.type).toBe('response');
    expect(binding.getBoundHandleId()).toBe('only');
    expect(calls[0].id).toBe('only');
  });

  it('errors with a helpful message when no handle is connected', async () => {
    const { client } = mockClient({ handles: [handle('a', false)] });
    const binding = new HandleBinding(client);
    const msg = await binding.requestWithRetry('ping');
    expect(msg.type).toBe('error');
    expect((msg.payload as { code: string }).code).toBe('HANDLE_NOT_FOUND');
    expect((msg.payload as { message: string }).message).toMatch(/No browser handle is connected/);
  });

  it('errors and lists handles when several are connected', async () => {
    const { client } = mockClient({ handles: [handle('a'), handle('b')] });
    const binding = new HandleBinding(client);
    const msg = await binding.requestWithRetry('ping');
    expect(msg.type).toBe('error');
    expect((msg.payload as { message: string }).message).toMatch(/Multiple browser handles/);
    expect((msg.payload as { message: string }).message).toContain('a');
    expect((msg.payload as { message: string }).message).toContain('b');
  });

  it('does not re-list once bound (sticky)', async () => {
    const { client } = mockClient({ handles: [handle('only')] });
    const binding = new HandleBinding(client);
    await binding.requestWithRetry('ping');
    await binding.requestWithRetry('ping');
    expect(client.listHandles).toHaveBeenCalledTimes(1);
  });
});

describe('HandleBinding explicit binding', () => {
  it('uses the explicit handle without listing', async () => {
    const { client, calls } = mockClient({ handles: [handle('a'), handle('b')] });
    const binding = new HandleBinding(client, { handleId: 'chosen' });
    await binding.requestWithRetry('ping');
    expect(client.listHandles).not.toHaveBeenCalled();
    expect(calls[0].id).toBe('chosen');
  });

  it('selectHandle rebinds', async () => {
    const { client, calls } = mockClient({ handles: [handle('a')] });
    const binding = new HandleBinding(client, { handleId: 'first' });
    await binding.requestWithRetry('ping');
    binding.selectHandle('second');
    await binding.requestWithRetry('ping');
    expect(calls.map((c) => c.id)).toEqual(['first', 'second']);
  });
});

describe('HandleBinding error propagation', () => {
  it('preserves a relay error code from listHandles (does not mask as HANDLE_NOT_FOUND)', async () => {
    const client = {
      listHandles: vi.fn(async () => {
        throw new BrowserHandleError('UNAUTHORIZED', 'Relay rejected the agent token', 401);
      }),
      call: vi.fn(),
      health: vi.fn(),
    } as unknown as BrowserHandleClient;
    const binding = new HandleBinding(client);
    const msg = await binding.requestWithRetry('ping');
    expect(msg.type).toBe('error');
    expect((msg.payload as { code: string }).code).toBe('UNAUTHORIZED');
  });
});

describe('HandleBinding disconnect auto-recovery', () => {
  it('rebinds to a newly-connected handle when an auto-bound handle disconnects', async () => {
    const callLog: string[] = [];
    // Initially only 'a' is connected, so the first auto-bind picks it.
    let handles: HandleInfo[] = [handle('a')];
    const client = {
      listHandles: vi.fn(async () => handles),
      call: vi.fn(async (id: string) => {
        callLog.push(id);
        if (id === 'a') {
          // 'a' has dropped; now 'b' is the only connected handle.
          handles = [handle('a', false), handle('b')];
          return { ok: false, error: { code: 'HANDLE_DISCONNECTED', message: 'gone' } } as CallResponse;
        }
        return { ok: true, result: { ok: true } } as CallResponse;
      }),
      health: vi.fn(),
    } as unknown as BrowserHandleClient;

    const binding = new HandleBinding(client);
    const msg = await binding.requestWithRetry('ping');
    expect(callLog).toEqual(['a', 'b']);
    expect(msg.type).toBe('response');
    expect(binding.getBoundHandleId()).toBe('b');
  });

  it('does NOT auto-switch away from an explicit --handle binding', async () => {
    const client = {
      listHandles: vi.fn(async () => [handle('b')]),
      call: vi.fn(async () => ({ ok: false, error: { code: 'HANDLE_DISCONNECTED', message: 'gone' } } as CallResponse)),
      health: vi.fn(),
    } as unknown as BrowserHandleClient;
    const binding = new HandleBinding(client, { handleId: 'explicit' });
    const msg = await binding.requestWithRetry('ping');
    expect(msg.type).toBe('error');
    expect((msg.payload as { code: string }).code).toBe('HANDLE_DISCONNECTED');
    expect(binding.getBoundHandleId()).toBe('explicit');
    expect(client.listHandles).not.toHaveBeenCalled();
  });
});

describe('HandleBinding concurrent auto-bind', () => {
  it('lists handles only once for concurrent first calls', async () => {
    const { client } = mockClient({ handles: [handle('only')] });
    const binding = new HandleBinding(client);
    await Promise.all([
      binding.requestWithRetry('ping'),
      binding.requestWithRetry('ping'),
      binding.requestWithRetry('ping'),
    ]);
    expect(client.listHandles).toHaveBeenCalledTimes(1);
    expect(binding.getBoundHandleId()).toBe('only');
  });
});

describe('HandleBinding CallResponse mapping', () => {
  it('maps ok:true to a response message', async () => {
    const { client } = mockClient({
      handles: [handle('h')],
      call: () => ({ ok: true, result: { foo: 1 } }),
    });
    const binding = new HandleBinding(client, { handleId: 'h' });
    const msg = await binding.requestWithRetry('evaluate');
    expect(msg.type).toBe('response');
    expect(msg.payload).toEqual({ foo: 1 });
  });

  it('maps ok:false to an error message preserving the code', async () => {
    const { client } = mockClient({
      handles: [handle('h')],
      call: () => ({ ok: false, error: { code: 'STALE_SNAPSHOT', message: 'stale' } }),
    });
    const binding = new HandleBinding(client, { handleId: 'h' });
    const msg = await binding.requestWithRetry('click');
    expect(msg.type).toBe('error');
    expect(msg.payload).toMatchObject({ code: 'STALE_SNAPSHOT', message: 'stale' });
  });
});
