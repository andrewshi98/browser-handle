/**
 * Relay connection configuration, persisted in chrome.storage.local.
 *
 * The handle id is generated once on first run and persisted forever, so the
 * same browser reattaches to the relay as the same handle across service
 * worker restarts and relay restarts. The relay URL, token, and name are
 * user-editable from the side panel.
 */
import { WEBSOCKET_DEFAULT_PORT, BROWSER_WS_PATH } from '@browserhandle/protocol';

export interface RelayConfig {
  /** WebSocket URL of the relay's browser endpoint */
  relayUrl: string;
  /** Browser token, if the relay requires one */
  token?: string;
  /** Human-readable label for this browser */
  name: string;
  /** Whether the extension should connect */
  enabled: boolean;
}

const CONFIG_KEY = 'bh.relayConfig';
const HANDLE_ID_KEY = 'bh.handleId';

/** Default relay URL: a relay on the local machine's default port. */
export const DEFAULT_RELAY_URL = `ws://127.0.0.1:${WEBSOCKET_DEFAULT_PORT}${BROWSER_WS_PATH}`;

export const DEFAULT_CONFIG: RelayConfig = {
  relayUrl: DEFAULT_RELAY_URL,
  name: 'Chrome',
  enabled: true,
};

/** Load the relay config, filling in defaults for any missing fields. */
export async function loadConfig(): Promise<RelayConfig> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const partial = (stored[CONFIG_KEY] ?? {}) as Partial<RelayConfig>;
  return { ...DEFAULT_CONFIG, ...partial };
}

/** Persist a partial config update, returning the merged result. */
export async function saveConfig(update: Partial<RelayConfig>): Promise<RelayConfig> {
  const current = await loadConfig();
  const merged = { ...current, ...update };
  await chrome.storage.local.set({ [CONFIG_KEY]: merged });
  return merged;
}

/**
 * Return this browser's stable handle id, generating and persisting one on
 * first call. Never user-editable.
 */
export async function getOrCreateHandleId(): Promise<string> {
  const stored = await chrome.storage.local.get(HANDLE_ID_KEY);
  const existing = stored[HANDLE_ID_KEY] as string | undefined;
  if (existing) return existing;
  const handleId = crypto.randomUUID();
  await chrome.storage.local.set({ [HANDLE_ID_KEY]: handleId });
  return handleId;
}

/** Subscribe to config changes (side panel edits). Returns an unsubscribe fn. */
export function onConfigChanged(listener: (config: RelayConfig) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ): void => {
    if (areaName !== 'local' || !(CONFIG_KEY in changes)) return;
    const next = (changes[CONFIG_KEY].newValue ?? {}) as Partial<RelayConfig>;
    listener({ ...DEFAULT_CONFIG, ...next });
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export const CONFIG_STORAGE_KEY = CONFIG_KEY;
export const HANDLE_ID_STORAGE_KEY = HANDLE_ID_KEY;
