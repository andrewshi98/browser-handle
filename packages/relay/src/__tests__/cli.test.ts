import { describe, it, expect } from 'vitest';
import { parseArgs, validateConfig } from '../cli.js';

describe('parseArgs', () => {
  it('returns defaults with no args or env', () => {
    const config = parseArgs([], {});
    expect(config).not.toBe('help');
    if (config === 'help') return;
    expect(config.port).toBe(18080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.agentToken).toBeUndefined();
    expect(config.browserToken).toBeUndefined();
    expect(config.logLevel).toBe('info');
  });

  it('parses flags', () => {
    const config = parseArgs(
      ['--port', '9000', '--host', '0.0.0.0', '--agent-token', 'a', '--browser-token', 'b', '--log-level', 'debug'],
      {}
    );
    if (config === 'help') throw new Error('unexpected help');
    expect(config).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      agentToken: 'a',
      browserToken: 'b',
      logLevel: 'debug',
    });
  });

  it('expands --token to both surfaces', () => {
    const config = parseArgs(['--token', 'shared'], {});
    if (config === 'help') throw new Error('unexpected help');
    expect(config.agentToken).toBe('shared');
    expect(config.browserToken).toBe('shared');
  });

  it('lets flags override env', () => {
    const config = parseArgs(['--port', '9000'], { BROWSERHANDLE_PORT: '1234', BROWSERHANDLE_HOST: 'localhost' });
    if (config === 'help') throw new Error('unexpected help');
    expect(config.port).toBe(9000);
    expect(config.host).toBe('localhost');
  });

  it('reads tokens from env', () => {
    const config = parseArgs([], {
      BROWSERHANDLE_AGENT_TOKEN: 'ea',
      BROWSERHANDLE_BROWSER_TOKEN: 'eb',
    });
    if (config === 'help') throw new Error('unexpected help');
    expect(config.agentToken).toBe('ea');
    expect(config.browserToken).toBe('eb');
  });

  it('returns help for --help', () => {
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(parseArgs(['-h'], {})).toBe('help');
  });

  it('throws on unknown options', () => {
    expect(() => parseArgs(['--bogus', 'x'], {})).toThrow(/Unknown option/);
  });

  it('throws on a missing flag value', () => {
    expect(() => parseArgs(['--port'], {})).toThrow(/Missing value/);
  });

  it('throws on an invalid port', () => {
    expect(() => parseArgs(['--port', 'abc'], {})).toThrow(/Invalid port/);
    expect(() => parseArgs(['--port', '99999'], {})).toThrow(/Invalid port/);
  });

  it('throws on an invalid log level', () => {
    expect(() => parseArgs(['--log-level', 'verbose'], {})).toThrow(/Invalid log level/);
  });
});

describe('validateConfig (fail-closed)', () => {
  const base = { port: 18080, logLevel: 'info' as const };

  it('allows loopback without tokens', () => {
    expect(validateConfig({ ...base, host: '127.0.0.1' })).toBeNull();
    expect(validateConfig({ ...base, host: 'localhost' })).toBeNull();
  });

  it('refuses a non-loopback host without tokens', () => {
    const err = validateConfig({ ...base, host: '0.0.0.0' });
    expect(err).toContain('Refusing to bind');
  });

  it('refuses a non-loopback host with only one token', () => {
    expect(validateConfig({ ...base, host: '0.0.0.0', agentToken: 'a' })).toContain('browser token');
    expect(validateConfig({ ...base, host: '0.0.0.0', browserToken: 'b' })).toContain('agent token');
  });

  it('allows a non-loopback host with both tokens', () => {
    expect(
      validateConfig({ ...base, host: '0.0.0.0', agentToken: 'a', browserToken: 'b' })
    ).toBeNull();
  });
});
