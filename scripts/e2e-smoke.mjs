#!/usr/bin/env node
/**
 * End-to-end smoke test for the relay topology.
 *
 *   relay (browserhandle-relay) <— WS — extension (real Chrome) <— driven by —>
 *   MCP adapter (browserhandle-mcp, stdio) — HTTP —> relay
 *
 * Starts a relay on the default port, launches Chrome-for-Testing with the
 * extension (which auto-dials the default relay URL), starts the MCP adapter,
 * and exercises the tools end-to-end.
 *
 * Requires a built repo (pnpm build) and a Chrome-for-Testing binary
 * (npx @puppeteer/browsers install chrome@stable, or set CHROME_PATH).
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const relayCli = resolve(root, 'packages/relay/dist/cli.js');
const mcpCli = resolve(root, 'packages/mcp/dist/cli.js');
const extensionPath = resolve(root, 'packages/extension/dist');
const PORT = 18080;

// Resolve puppeteer-core from the extension package (where it is installed).
const extRequire = createRequire(resolve(root, 'packages/extension/package.json'));
const puppeteer = (await import(pathToFileURL(extRequire.resolve('puppeteer-core')))).default;

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[36mℹ\x1b[0m';
let passed = 0;
let failed = 0;
function assert(cond, label, detail = '') {
  if (cond) { console.log(`  ${PASS} ${label}`); passed++; }
  else { console.log(`  ${FAIL} ${label} ${detail}`); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [process.env.CHROME_PATH];
  try {
    const found = execSync('find chrome -name "Google Chrome for Testing" -o -name chrome -type f 2>/dev/null', {
      cwd: root, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    candidates.push(...found);
  } catch { /* ignore */ }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium');
  for (const c of candidates) {
    if (c) { try { readFileSync(c); return c; } catch { /* keep looking */ } }
  }
  throw new Error('No Chrome found. Set CHROME_PATH or run: npx @puppeteer/browsers install chrome@stable');
}

// --- MCP stdio JSON-RPC plumbing ---
let mcp;
let nextId = 1;
let buffer = '';
const resolvers = new Map();

function rpc(method, params = {}) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { resolvers.delete(id); rej(new Error(`Timeout on ${method}`)); }, 60_000);
    resolvers.set(id, { res: (v) => { clearTimeout(timer); res(v); } });
  });
}
function notify(method, params = {}) {
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
function onMcpData(chunk) {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t);
      if (msg.id != null && resolvers.has(msg.id)) {
        const { res } = resolvers.get(msg.id);
        resolvers.delete(msg.id);
        res(msg);
      }
    } catch { /* ignore */ }
  }
}
const callTool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.result ?? r?.error ?? r);
const isError = (r) => r?.result?.isError === true || r?.error != null;

let relay, browser;
async function cleanup() {
  try { await browser?.close(); } catch { /* ignore */ }
  try { mcp?.kill('SIGTERM'); } catch { /* ignore */ }
  try { relay?.kill('SIGTERM'); } catch { /* ignore */ }
}

async function main() {
  // 1. Relay on the default port (extension auto-dials ws://127.0.0.1:18080/ws/browser).
  console.log(`\n${INFO} Starting relay on port ${PORT}...`);
  relay = spawn('node', [relayCli, '--port', String(PORT), '--log-level', 'info'], { stdio: ['ignore', 'inherit', 'inherit'] });
  await sleep(800);

  // 2. Launch Chrome with the extension.
  console.log(`${INFO} Launching Chrome with the extension...`);
  const userDataDir = mkdtempSync(resolve(tmpdir(), 'bh-smoke-'));
  browser = await puppeteer.launch({
    headless: false,
    executablePath: findChrome(),
    ignoreAllDefaultArgs: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--use-mock-keychain', '--password-store=basic',
    ],
  });

  // 3. Wait for the extension to register a handle with the relay.
  console.log(`${INFO} Waiting for the browser handle to register...`);
  let handleId = null;
  for (let i = 0; i < 60 && !handleId; i++) {
    await sleep(1000);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/handles`);
      const handles = await res.json();
      const connected = handles.find((h) => h.connected);
      if (connected) handleId = connected.handleId;
    } catch { /* relay or SW not ready yet */ }
  }
  assert(!!handleId, `Browser handle registered (${handleId})`);
  if (!handleId) throw new Error('Extension never registered with the relay');

  // 4. Start the MCP adapter (default relay URL http://127.0.0.1:18080).
  console.log(`${INFO} Starting MCP adapter...`);
  mcp = spawn('node', [mcpCli], { stdio: ['pipe', 'pipe', 'inherit'] });
  mcp.stdout.on('data', (c) => onMcpData(c.toString()));
  await sleep(500);

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-smoke', version: '0.0.1' },
  });
  assert(init.result?.serverInfo?.name === 'browserhandle', 'MCP server identifies as browserhandle');
  notify('notifications/initialized');
  await sleep(200);

  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  assert(names.length === 23, `23 tools registered (got ${names.length})`);
  assert(names.includes('list_browser_handles'), 'list_browser_handles registered');

  // 5. Tool round-trips through relay -> extension.
  console.log('\n--- list_browser_handles ---');
  let r = await callTool('list_browser_handles', {});
  assert(!isError(r) && text(r).includes(handleId), 'list_browser_handles shows the handle');
  console.log(`  ${INFO} ${text(r).split('\n').slice(0, 3).join(' / ')}`);

  console.log('\n--- navigate_to ---');
  r = await callTool('navigate_to', { url: 'https://example.com' });
  assert(!isError(r), 'navigate_to example.com');
  console.log(`  ${INFO} ${text(r).replace(/\n/g, ' ')}`);

  console.log('\n--- page_snapshot ---');
  r = await callTool('page_snapshot', {});
  assert(!isError(r), 'page_snapshot succeeds');
  const snapshotId = text(r).match(/Snapshot ID: (snap-[^\n]+)/)?.[1];
  assert(!!snapshotId, `got snapshot id ${snapshotId}`);

  console.log('\n--- screenshot ---');
  r = await callTool('screenshot', {});
  assert(r?.result?.content?.[0]?.type === 'image', 'screenshot returns an image');

  console.log('\n--- disconnect mid-flight recovery ---');
  await browser.close();
  browser = null;
  await sleep(500);
  r = await callTool('list_tabs', {});
  assert(isError(r), 'tool call errors after the browser disconnects');
  console.log(`  ${INFO} ${text(r).split('\n')[0]}`);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nFatal error:', err.message);
  await cleanup();
  process.exit(1);
});
