import { describe, it, expect } from 'vitest';
import {
  tokensMatch,
  browserAuthorized,
  agentAuthorized,
  isLoopbackHost,
} from '../auth.js';

describe('tokensMatch', () => {
  it('matches identical tokens', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true);
  });

  it('rejects different tokens', () => {
    expect(tokensMatch('secret', 'wrong')).toBe(false);
  });

  it('rejects tokens of different lengths without throwing', () => {
    expect(tokensMatch('secret', 's')).toBe(false);
    expect(tokensMatch('s', 'secret-longer')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(tokensMatch('secret', undefined)).toBe(false);
  });

  it('rejects empty provided against non-empty expected', () => {
    expect(tokensMatch('secret', '')).toBe(false);
  });
});

describe('browserAuthorized', () => {
  it('allows any token when no browser token is configured', () => {
    expect(browserAuthorized({}, undefined)).toBe(true);
    expect(browserAuthorized({}, 'anything')).toBe(true);
  });

  it('requires a matching token when configured', () => {
    const auth = { browserToken: 'bt' };
    expect(browserAuthorized(auth, 'bt')).toBe(true);
    expect(browserAuthorized(auth, 'nope')).toBe(false);
    expect(browserAuthorized(auth, undefined)).toBe(false);
  });
});

describe('agentAuthorized', () => {
  it('allows any request when no agent token is configured', () => {
    expect(agentAuthorized({}, undefined)).toBe(true);
    expect(agentAuthorized({}, 'Bearer whatever')).toBe(true);
  });

  it('accepts a correct bearer token', () => {
    const auth = { agentToken: 'at' };
    expect(agentAuthorized(auth, 'Bearer at')).toBe(true);
  });

  it('is case-insensitive on the Bearer scheme', () => {
    const auth = { agentToken: 'at' };
    expect(agentAuthorized(auth, 'bearer at')).toBe(true);
  });

  it('rejects a wrong token', () => {
    const auth = { agentToken: 'at' };
    expect(agentAuthorized(auth, 'Bearer wrong')).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    const auth = { agentToken: 'at' };
    expect(agentAuthorized(auth, undefined)).toBe(false);
    expect(agentAuthorized(auth, 'at')).toBe(false);
    expect(agentAuthorized(auth, 'Basic at')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
  });
});
