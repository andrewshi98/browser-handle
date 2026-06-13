#!/usr/bin/env node
/**
 * BrowserHandle relay CLI.
 *
 * Usage:
 *   browserhandle-relay [--port 18080] [--host 127.0.0.1]
 *                       [--token T | --agent-token A --browser-token B]
 *                       [--log-level info]
 *
 * Env (flags take precedence; prefer env for tokens - flags leak into ps):
 *   BROWSERHANDLE_PORT, BROWSERHANDLE_HOST, BROWSERHANDLE_TOKEN,
 *   BROWSERHANDLE_AGENT_TOKEN, BROWSERHANDLE_BROWSER_TOKEN,
 *   BROWSERHANDLE_LOG_LEVEL
 *
 * Binding to a non-loopback host without both tokens refuses to start.
 */
import { createRelay, DEFAULT_HOST, DEFAULT_PORT } from './server.js';
import { isLoopbackHost } from './auth.js';
import { createLogger } from './logger.js';
import type { LogLevel } from './logger.js';
import { RELAY_VERSION } from './version.js';

const HELP = `browserhandle-relay ${RELAY_VERSION} - BrowserHandle relay server

Routes agents to browser extensions by browser_handle_id.

Usage:
  browserhandle-relay [options]

Options:
  --port <n>             Port to listen on (default ${DEFAULT_PORT})
  --host <host>          Host to bind (default ${DEFAULT_HOST})
  --token <t>            Shorthand: use the same token for both surfaces
  --agent-token <t>      Token agents must send as "Authorization: Bearer <t>"
  --browser-token <t>    Token extensions must send in their register message
  --log-level <level>    debug | info | warn | error (default info)
  --help                 Show this help

Environment variables (flags take precedence):
  BROWSERHANDLE_PORT, BROWSERHANDLE_HOST, BROWSERHANDLE_TOKEN,
  BROWSERHANDLE_AGENT_TOKEN, BROWSERHANDLE_BROWSER_TOKEN, BROWSERHANDLE_LOG_LEVEL

Surfaces:
  ws://<host>:<port>/ws/browser     extension connections (register handshake)
  http://<host>:<port>/healthz      liveness
  http://<host>:<port>/v1/handles   agent API

Security:
  - Bound to loopback without tokens: auth is disabled (local development).
  - Binding to any other host requires BOTH an agent token and a browser
    token; the relay refuses to start otherwise.
  - TLS is not terminated in-process: put the relay behind a reverse proxy
    (wss:// + https://) for remote deployments.

Documentation: https://github.com/andrewshi98/browser-handle
`;

interface CliConfig {
  port: number;
  host: string;
  agentToken?: string;
  browserToken?: string;
  logLevel: LogLevel;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliConfig | 'help' {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  for (const key of flags.keys()) {
    if (!['port', 'host', 'token', 'agent-token', 'browser-token', 'log-level'].includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
  }

  const portRaw = flags.get('port') ?? env.BROWSERHANDLE_PORT;
  const port = portRaw !== undefined ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const sharedToken = flags.get('token') ?? env.BROWSERHANDLE_TOKEN;
  const logLevelRaw = flags.get('log-level') ?? env.BROWSERHANDLE_LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    throw new Error(`Invalid log level: ${logLevelRaw}`);
  }

  return {
    port,
    host: flags.get('host') ?? env.BROWSERHANDLE_HOST ?? DEFAULT_HOST,
    agentToken: flags.get('agent-token') ?? env.BROWSERHANDLE_AGENT_TOKEN ?? sharedToken,
    browserToken: flags.get('browser-token') ?? env.BROWSERHANDLE_BROWSER_TOKEN ?? sharedToken,
    logLevel: logLevelRaw as LogLevel,
  };
}

/** Returns an error message when the config must not start, else null */
export function validateConfig(config: CliConfig): string | null {
  if (!isLoopbackHost(config.host)) {
    const missing: string[] = [];
    if (config.agentToken === undefined) missing.push('an agent token');
    if (config.browserToken === undefined) missing.push('a browser token');
    if (missing.length > 0) {
      return (
        `Refusing to bind to non-loopback host ${config.host} without ${missing.join(' and ')}.\n` +
        'Set --token (or BROWSERHANDLE_TOKEN), or --agent-token and --browser-token.'
      );
    }
  }
  return null;
}

async function main(): Promise<void> {
  let config: CliConfig | 'help';
  try {
    config = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Run browserhandle-relay --help for usage.');
    process.exit(1);
  }

  if (config === 'help') {
    console.log(HELP);
    return;
  }

  const invalid = validateConfig(config);
  if (invalid !== null) {
    console.error(invalid);
    process.exit(1);
  }

  const log = createLogger(config.logLevel);
  const relay = createRelay({
    host: config.host,
    port: config.port,
    auth: { agentToken: config.agentToken, browserToken: config.browserToken },
    log,
  });

  try {
    await relay.listen();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('EADDRINUSE')) {
      console.error(
        `Port ${config.port} is already in use. Another relay may be running.\n` +
          `Pick another port with --port or BROWSERHANDLE_PORT.`
      );
    } else {
      console.error(`Failed to start relay: ${message}`);
    }
    process.exit(1);
  }

  const shutdown = (): void => {
    void relay.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run when executed as a CLI, not when imported by tests
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/cli.js') || process.argv[1].endsWith('browserhandle-relay'));
if (isMain) {
  void main();
}
