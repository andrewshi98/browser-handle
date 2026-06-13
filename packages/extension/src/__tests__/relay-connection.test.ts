import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageRouter } from '../background/message-router';
import type { RelayConfig } from '../background/connection-config';

/** Controllable fake WebSocket exposing event triggers to the test. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  // --- test triggers ---
  emit(type: string, ev: unknown): void {
    (this.listeners[type] ?? []).forEach((fn) => fn(ev));
  }
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }
  triggerMessage(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason: '' });
  }
  sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const config: RelayConfig = {
  relayUrl: 'ws://127.0.0.1:18080/ws/browser',
  name: 'Test Browser',
  enabled: true,
};

function fakeRouter(handler?: (req: unknown) => Promise<unknown>): MessageRouter {
  return {
    handleBridgeRequest: vi.fn(handler ?? (async () => ({
      id: 'x',
      type: 'response',
      method: 'ping',
      payload: { pong: true },
      timestamp: 0,
    }))),
  } as unknown as MessageRouter;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.1.0' }) } });
});

async function importRelayConnection() {
  vi.resetModules();
  return import('../background/relay-connection');
}

describe('RelayConnection registration', () => {
  it('connects, sends a register message, and becomes ready on registered', async () => {
    const { RelayConnection } = await importRelayConnection();
    const statuses: string[] = [];
    const conn = new RelayConnection(config, 'handle-1', fakeRouter(), (s) => statuses.push(s.state));
    conn.start();

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe(config.relayUrl);

    ws.triggerOpen();
    const register = ws.sentMessages()[0];
    expect(register).toMatchObject({
      type: 'register',
      protocolVersion: 1,
      handleId: 'handle-1',
      name: 'Test Browser',
    });

    ws.triggerMessage({ type: 'registered', handleId: 'handle-1', protocolVersion: 1, relayVersion: '0.1.0' });
    expect(conn.getStatus().state).toBe('ready');
    expect(conn.isReady()).toBe(true);
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('registering');
    expect(statuses).toContain('ready');
  });

  it('does not connect when disabled', async () => {
    const { RelayConnection } = await importRelayConnection();
    const conn = new RelayConnection({ ...config, enabled: false }, 'h', fakeRouter());
    conn.start();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(conn.getStatus().state).toBe('disabled');
  });
});

describe('RelayConnection request handling', () => {
  it('acks and routes a bridge request, then sends the response', async () => {
    const { RelayConnection } = await importRelayConnection();
    const router = fakeRouter(async () => ({
      id: 'req-1',
      type: 'response',
      method: 'click',
      payload: { clicked: true },
      timestamp: 0,
    }));
    const conn = new RelayConnection(config, 'h', router);
    conn.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    ws.triggerMessage({ type: 'registered', handleId: 'h', protocolVersion: 1, relayVersion: '0.1.0' });

    ws.triggerMessage({ id: 'req-1', type: 'request', method: 'click', payload: { ref: '@e1' }, timestamp: 0 });
    await vi.waitFor(() => {
      const types = ws.sentMessages().map((m) => m.type);
      expect(types).toContain('ack');
      expect(types).toContain('response');
    });

    expect(router.handleBridgeRequest).toHaveBeenCalledOnce();
    const ack = ws.sentMessages().find((m) => m.type === 'ack');
    expect(ack).toMatchObject({ id: 'req-1', method: 'click' });
  });
});

describe('RelayConnection auth error', () => {
  it('enters auth-error state on a 4401 close', async () => {
    const { RelayConnection } = await importRelayConnection();
    const conn = new RelayConnection(config, 'h', fakeRouter());
    conn.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    ws.triggerMessage({ type: 'relay-error', code: 'UNAUTHORIZED', message: 'bad token' });
    ws.serverClose(4401);
    expect(conn.getStatus().state).toBe('auth-error');
    expect(conn.getStatus().detail).toContain('UNAUTHORIZED');
    conn.stop();
  });

  it('does not reconnect after a 4409 supersede close', async () => {
    const { RelayConnection } = await importRelayConnection();
    const conn = new RelayConnection(config, 'h', fakeRouter());
    conn.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    ws.triggerMessage({ type: 'registered', handleId: 'h', protocolVersion: 1, relayVersion: '0.1.0' });
    ws.serverClose(4409);
    expect(conn.getStatus().state).toBe('idle');
  });
});
