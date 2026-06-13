/**
 * BrowserHandle installer.
 *
 * Outputs Claude Desktop configuration.
 */
import { resolve } from 'node:path';
import { platform, env } from 'node:process';
import { DEFAULT_RELAY_URL } from './config.js';

export async function install(): Promise<void> {
  console.log('BrowserHandle Installer');
  console.log('=================\n');

  outputClaudeDesktopConfig();

  console.log(`\nRelay URL: ${DEFAULT_RELAY_URL} (override with --relay-url or BROWSERHANDLE_RELAY_URL)`);
  console.log('Start a relay with: npx @browserhandle/relay');
  console.log('\nInstallation complete!');
}

function outputClaudeDesktopConfig(): void {
  const config = {
    mcpServers: {
      browserhandle: {
        command: 'npx',
        args: ['-y', '@browserhandle/mcp'],
      },
    },
  };

  console.log('Claude Desktop configuration:');
  console.log('Add the following to your claude_desktop_config.json:\n');
  console.log(JSON.stringify(config, null, 2));

  // Determine config file location
  const home = env.HOME ?? env.USERPROFILE ?? '';
  let configPath: string;

  switch (platform) {
    case 'darwin':
      configPath = resolve(
        home,
        'Library/Application Support/Claude/claude_desktop_config.json'
      );
      break;
    case 'linux':
      configPath = resolve(home, '.config/Claude/claude_desktop_config.json');
      break;
    case 'win32':
      configPath = resolve(
        env.APPDATA ?? resolve(home, 'AppData/Roaming'),
        'Claude/claude_desktop_config.json'
      );
      break;
    default:
      configPath = 'claude_desktop_config.json';
  }

  console.log(`\nConfig file location:\n  ${configPath}`);
}
