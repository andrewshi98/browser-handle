import { describe, it, expect, afterEach } from 'vitest';
import { WS_CLOSE_UNAUTHORIZED } from '@browserhandle/protocol';
import type { CallResponse } from '@browserhandle/protocol';
import { createRelay } from '../server.js';
import type { Relay } from '../server.js';
import type { AuthConfig } from '../auth.js';
import { connectFakeExtension, FakeExtension } from './fake-extension.js';

let relay: Relay | null = null;
const openExtensions: FakeExtension[] = [];

afterEach(async () => {
  for (const ext of openExtensions.splice(0)) ext.close();
  if (relay) {
    await relay.close();
    relay = null;
  }
});

async function start(auth: AuthConfig): Promise<{ port: number; base: string }> {
  relay = createRelay({ host: '127.0.0.1', port: 0, auth });
  const { port } = await relay.listen();
  return { port, base: `http://127.0.0.1:${port}` };
}

describe('agent HTTP auth', () => {
  it('rejects /v1/handles without a bearer token (401)', async () => {
    const { base } = await start({ agentToken: 'at' });
    const res = await fetch(`${base}/v1/handles`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as CallResponse;
    if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong bearer token (401)', async () => {
    const { base } = await start({ agentToken: 'at' });
    const res = await fetch(`${base}/v1/handles`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer token', async () => {
    const { base } = await start({ agentToken: 'at' });
    const res = await fetch(`${base}/v1/handles`, { headers: { authorization: 'Bearer at' } });
    expect(res.status).toBe(200);
  });

  it('leaves /healthz open even with auth configured', async () => {
    const { base } = await start({ agentToken: 'at', browserToken: 'bt' });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe('browser register auth', () => {
  it('rejects a register with a wrong token, closing with 4401', async () => {
    const { port } = await start({ browserToken: 'bt' });
    const ext = new FakeExtension(port, { handleId: 'h1', token: 'wrong' });
    openExtensions.push(ext);
    const { code } = await ext.closed;
    expect(code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(ext.relayErrors[0]?.code).toBe('UNAUTHORIZED');
  });

  it('accepts a register with the correct token', async () => {
    const { port } = await start({ browserToken: 'bt' });
    const ext = await connectFakeExtension(port, { handleId: 'h1', token: 'bt' });
    openExtensions.push(ext);
    const reg = await ext.registered;
    expect(reg.handleId).toBe('h1');
  });

  it('requires a token when one is configured (missing token rejected)', async () => {
    const { port } = await start({ browserToken: 'bt' });
    const ext = new FakeExtension(port, { handleId: 'h1' }); // no token
    openExtensions.push(ext);
    const { code } = await ext.closed;
    expect(code).toBe(WS_CLOSE_UNAUTHORIZED);
  });
});

describe('tokenless loopback mode', () => {
  it('accepts both surfaces without any token', async () => {
    const { port, base } = await start({});
    const ext = await connectFakeExtension(port, { handleId: 'h1' });
    openExtensions.push(ext);
    const res = await fetch(`${base}/v1/handles`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });
});
