import { describe, it, expect } from 'vitest';
import { parseMcpArgs, DEFAULT_RELAY_URL } from '../config.js';

describe('parseMcpArgs', () => {
  it('returns defaults with no args or env', () => {
    const config = parseMcpArgs([], {});
    expect(config).toEqual({ relayUrl: DEFAULT_RELAY_URL, token: undefined, handleId: undefined });
  });

  it('parses flags', () => {
    const config = parseMcpArgs(
      ['--relay-url', 'https://relay.example.com', '--token', 't', '--handle', 'h1'],
      {}
    );
    expect(config).toEqual({ relayUrl: 'https://relay.example.com', token: 't', handleId: 'h1' });
  });

  it('reads from env when flags are absent', () => {
    const config = parseMcpArgs([], {
      BROWSERHANDLE_RELAY_URL: 'http://r:9',
      BROWSERHANDLE_AGENT_TOKEN: 'et',
      BROWSERHANDLE_HANDLE_ID: 'eh',
    });
    expect(config).toEqual({ relayUrl: 'http://r:9', token: 'et', handleId: 'eh' });
  });

  it('lets flags override env', () => {
    const config = parseMcpArgs(['--relay-url', 'http://flag'], {
      BROWSERHANDLE_RELAY_URL: 'http://env',
    });
    expect(config.relayUrl).toBe('http://flag');
  });

  it('falls back to BROWSERHANDLE_TOKEN for the agent token', () => {
    const config = parseMcpArgs([], { BROWSERHANDLE_TOKEN: 'shared' });
    expect(config.token).toBe('shared');
  });

  it('throws on unknown options', () => {
    expect(() => parseMcpArgs(['--bogus', 'x'], {})).toThrow(/Unknown option/);
  });

  it('throws on a missing flag value', () => {
    expect(() => parseMcpArgs(['--relay-url'], {})).toThrow(/Missing value/);
  });
});
