/**
 * CLI/env configuration for the MCP adapter.
 *
 * The adapter is a relay client: it never binds a port and never launches a
 * browser. It needs a relay URL, an optional agent token, and an optional
 * explicit handle to bind.
 */
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:18080';

export interface McpConfig {
  relayUrl: string;
  token?: string;
  handleId?: string;
}

export function parseMcpArgs(argv: string[], env: NodeJS.ProcessEnv): McpConfig {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!['relay-url', 'token', 'handle'].includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  return {
    relayUrl: flags.get('relay-url') ?? env.BROWSERHANDLE_RELAY_URL ?? DEFAULT_RELAY_URL,
    token: flags.get('token') ?? env.BROWSERHANDLE_AGENT_TOKEN ?? env.BROWSERHANDLE_TOKEN,
    handleId: flags.get('handle') ?? env.BROWSERHANDLE_HANDLE_ID,
  };
}
