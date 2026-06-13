/**
 * Side Panel - connection settings + real-time agent activity log.
 */
import { SIDE_PANEL_UPDATE_CHANNEL, STATUS_CHANNEL, STATUS_REQUEST_CHANNEL } from '@browserhandle/protocol';
import { loadConfig, saveConfig } from '../background/connection-config';
import type { ConnectionState, RelayConnectionStatus } from '../background/relay-connection';

const logContainer = document.getElementById('logContainer')!;
const emptyState = document.getElementById('emptyState')!;
const statusEl = document.getElementById('status')!;
const clearBtn = document.getElementById('clearBtn')!;

// Settings form elements
const relayUrlInput = document.getElementById('relayUrl') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const enabledInput = document.getElementById('enabled') as HTMLInputElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const statusDetailEl = document.getElementById('statusDetail')!;
const handleIdEl = document.getElementById('handleId')!;

let entries: LogEntry[] = [];

interface LogEntry {
  action: string;
  timestamp: number;
  url?: string;
  [key: string]: unknown;
}

// --- Connection settings ---
const STATUS_LABELS: Record<ConnectionState, { label: string; cls: string }> = {
  ready: { label: 'Connected', cls: 'connected' },
  connecting: { label: 'Connecting…', cls: 'connecting' },
  registering: { label: 'Registering…', cls: 'connecting' },
  backoff: { label: 'Reconnecting…', cls: 'warn' },
  'auth-error': { label: 'Auth failed', cls: 'error' },
  disabled: { label: 'Disabled', cls: 'idle' },
  idle: { label: 'Idle', cls: 'idle' },
};

async function initSettings(): Promise<void> {
  const config = await loadConfig();
  relayUrlInput.value = config.relayUrl;
  tokenInput.value = config.token ?? '';
  nameInput.value = config.name;
  enabledInput.checked = config.enabled;

  // Pull the current connection status from the service worker.
  chrome.runtime.sendMessage({ channel: STATUS_REQUEST_CHANNEL }).then((resp) => {
    if (resp?.status) renderStatus(resp.status as RelayConnectionStatus);
  }).catch(() => {});
}

saveBtn.addEventListener('click', () => {
  void saveConfig({
    relayUrl: relayUrlInput.value.trim(),
    token: tokenInput.value.trim() || undefined,
    name: nameInput.value.trim() || 'Chrome',
    enabled: enabledInput.checked,
  });
});

function renderStatus(status: RelayConnectionStatus): void {
  const info = STATUS_LABELS[status.state] ?? STATUS_LABELS.idle;
  statusEl.textContent = info.label;
  statusEl.className = `status ${info.cls}`;
  statusDetailEl.textContent = status.detail
    ? `${status.relayUrl} — ${status.detail}`
    : status.relayUrl;
  handleIdEl.textContent = status.handleId ? `handle ${status.handleId}` : '';
}

void initSettings();

// Listen for activity + status updates from the service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.channel === SIDE_PANEL_UPDATE_CHANNEL && message.type === 'activity') {
    addLogEntry(message.data as LogEntry);
  }
  if (message.channel === STATUS_CHANNEL && message.status) {
    renderStatus(message.status as RelayConnectionStatus);
  }
});

// Clear button
clearBtn.addEventListener('click', () => {
  entries = [];
  logContainer.innerHTML = '';
  emptyState.style.display = 'flex';
  logContainer.appendChild(emptyState);
});

function addLogEntry(entry: LogEntry): void {
  entries.push(entry);

  // Hide empty state
  if (emptyState.parentElement) {
    emptyState.style.display = 'none';
  }

  // Create log element using DOM APIs to prevent XSS
  const el = document.createElement('div');
  el.className = 'log-entry';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'timestamp';
  timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString();
  el.appendChild(timeSpan);

  const actionSpan = document.createElement('span');
  actionSpan.className = 'action-name';
  actionSpan.textContent = entry.action;
  el.appendChild(actionSpan);

  const detailKeys = Object.keys(entry).filter(
    (k) => !['action', 'timestamp', 'url'].includes(k)
  );
  if (detailKeys.length > 0) {
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'details';
    detailsDiv.textContent = detailKeys
      .map((k) => `${k}: ${JSON.stringify(entry[k])}`)
      .join(' | ');
    el.appendChild(detailsDiv);
  }

  logContainer.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth' });
}
