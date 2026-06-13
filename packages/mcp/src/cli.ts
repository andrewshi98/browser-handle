#!/usr/bin/env node
/**
 * BrowserHandle MCP adapter CLI.
 *
 * A thin stdio MCP server that forwards browser-control tools to a browser
 * handle through a relay. It is a relay client: it binds no port and launches
 * no browser. Run a relay (browserhandle-relay) and load the extension first.
 *
 * Usage:
 *   npx @browserhandle/mcp                       Start the MCP server (stdio)
 *   npx @browserhandle/mcp install               Output Claude Desktop config
 *   npx @browserhandle/mcp --help                Show usage
 *
 * Options / env:
 *   --relay-url <url>  BROWSERHANDLE_RELAY_URL   Relay base URL (default http://127.0.0.1:18080)
 *   --token <t>        BROWSERHANDLE_AGENT_TOKEN Agent bearer token
 *   --handle <id>      BROWSERHANDLE_HANDLE_ID   Bind to a specific browser handle
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserHandleClient } from '@browserhandle/client';
import { createBrowserHandleServer } from './server.js';
import { HandleBinding } from './handle-binding.js';
import { install } from './installer.js';
import { parseMcpArgs, DEFAULT_RELAY_URL } from './config.js';

const HELP = `@browserhandle/mcp - expose a browser handle to MCP clients

Usage:
  npx @browserhandle/mcp                Start the MCP server (stdio transport)
  npx @browserhandle/mcp install        Output Claude Desktop config
  npx @browserhandle/mcp --help         Show this help message

Options (env var in parentheses):
  --relay-url <url>   (BROWSERHANDLE_RELAY_URL)    Relay base URL, default ${DEFAULT_RELAY_URL}
  --token <token>     (BROWSERHANDLE_AGENT_TOKEN)  Agent bearer token for the relay
  --handle <id>       (BROWSERHANDLE_HANDLE_ID)    Bind to a specific browser handle

How it works:
  The adapter forwards tools to a browser handle through a relay. Start a relay
  (browserhandle-relay), load the BrowserHandle Chrome extension and point it at
  the relay, then run this adapter. With exactly one connected handle it binds
  automatically; otherwise use select_browser_handle or pass --handle.

Claude Desktop config:
  {
    "mcpServers": {
      "browserhandle": { "command": "npx", "args": ["-y", "@browserhandle/mcp"] }
    }
  }

More info: https://github.com/andrewshi98/browser-handle`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (argv[0] === 'install') {
    await install();
    return;
  }

  let config;
  try {
    config = parseMcpArgs(argv, process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Run @browserhandle/mcp --help for usage.');
    process.exit(1);
  }

  const client = new BrowserHandleClient({ relayUrl: config.relayUrl, token: config.token });
  const binding = new HandleBinding(client, { handleId: config.handleId });

  const server = createBrowserHandleServer({ transport: binding });
  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  console.error(
    `[BrowserHandle] MCP Server started (stdio transport), relay ${config.relayUrl}` +
      (config.handleId ? `, handle ${config.handleId}` : '')
  );

  const shutdown = (): void => {
    console.error('[BrowserHandle] Shutting down...');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
