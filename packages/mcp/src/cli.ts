#!/usr/bin/env node
/**
 * BrowserHandle CLI entry point.
 *
 * Usage:
 *   npx @browserhandle/mcp          - Start the MCP server (stdio transport + WebSocket)
 *   npx @browserhandle/mcp install  - Output Claude Desktop config
 *   npx @browserhandle/mcp --help   - Show usage information
 */
import { createBrowserHandleServer } from './server.js';
import { WebSocketClient } from './ws-client.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { install } from './installer.js';
import { WEBSOCKET_DEFAULT_PORT, WEBSOCKET_PORT_ENV, WEBSOCKET_PORT_RANGE_SIZE } from '@browserhandle/protocol';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`@browserhandle/mcp - WebMCP-native browser agent

Usage:
  npx @browserhandle/mcp              Start the MCP server (stdio + WebSocket)
  npx @browserhandle/mcp install      Output Claude Desktop config
  npx @browserhandle/mcp --help       Show this help message

Description:
  BrowserHandle enables AI assistants like Claude to interact with web pages
  through a Chrome extension and MCP protocol. The MCP server communicates
  with the Chrome extension via a localhost WebSocket connection.

Environment variables:
  ${WEBSOCKET_PORT_ENV}    WebSocket port (default: ${WEBSOCKET_DEFAULT_PORT})

Claude Desktop config:
  {
    "mcpServers": {
      "browserhandle": { "command": "npx", "args": ["-y", "@browserhandle/mcp"] }
    }
  }

More info: https://github.com/andrewshi98/browser-handle`);
  process.exit(0);
} else if (args[0] === 'install') {
  await install();
} else {
  const explicitPort = process.env[WEBSOCKET_PORT_ENV] ? Number(process.env[WEBSOCKET_PORT_ENV]) : null;

  let wsClient: WebSocketClient;

  if (explicitPort !== null) {
    // Explicit port: use only that port (backward compatible)
    try {
      wsClient = await WebSocketClient.create(explicitPort);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE') {
        console.error(
          `[BrowserHandle] Port ${explicitPort} is already in use.\n` +
            `  Another BrowserHandle instance may be running. To fix:\n` +
            `    lsof -ti:${explicitPort} | xargs kill\n` +
            `  Or use a different port:\n` +
            `    ${WEBSOCKET_PORT_ENV}=${explicitPort + 1} npx @browserhandle/mcp`,
        );
      } else {
        console.error(`[BrowserHandle] WebSocket server error: ${error.message}`);
      }
      process.exit(1);
    }
    console.error(`[BrowserHandle] WebSocket server listening on 127.0.0.1:${explicitPort}`);
  } else {
    // Auto-scan port range
    let boundPort: number | null = null;
    wsClient = null!;
    for (let i = 0; i < WEBSOCKET_PORT_RANGE_SIZE; i++) {
      const port = WEBSOCKET_DEFAULT_PORT + i;
      try {
        wsClient = await WebSocketClient.create(port);
        boundPort = port;
        break;
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'EADDRINUSE') {
          continue;
        }
        console.error(`[BrowserHandle] WebSocket server error: ${error.message}`);
        process.exit(1);
      }
    }
    if (boundPort === null) {
      console.error(
        `[BrowserHandle] All ports in range ${WEBSOCKET_DEFAULT_PORT}–${WEBSOCKET_DEFAULT_PORT + WEBSOCKET_PORT_RANGE_SIZE - 1} are in use.\n` +
          `  ${WEBSOCKET_PORT_RANGE_SIZE} BrowserHandle instances may already be running.`,
      );
      process.exit(1);
    }
    console.error(`[BrowserHandle] WebSocket server listening on 127.0.0.1:${boundPort}`);
  }

  const cleanup = async () => {
    console.error('[BrowserHandle] Shutting down...');
    await wsClient.close();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  const server = createBrowserHandleServer({ wsClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[BrowserHandle] MCP Server started (stdio transport)`);
}
