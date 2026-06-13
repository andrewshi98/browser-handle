/**
 * Tests for handle binding: auto-bind when exactly one handle is connected,
 * instructive errors otherwise, explicit binding, and CallResponse mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { HandleBinding } from '../handle-binding.js';
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
