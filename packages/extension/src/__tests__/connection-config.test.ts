import { describe, it, expect, beforeEach, vi } from 'vitest';

/** In-memory chrome.storage.local with an onChanged dispatcher. */
function makeChromeStorage() {
  const store = new Map<string, unknown>();
  const changeListeners: Array<(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void> = [];
  return {
    store,
    chrome: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) {
              const oldValue = store.get(k);
              store.set(k, v);
              for (const l of changeListeners) l({ [k]: { newValue: v, oldValue } }, 'local');
            }
          }),
        },
        onChanged: {
          addListener: vi.fn((fn: never) => changeListeners.push(fn)),
          removeListener: vi.fn(),
        },
      },
    },
  };
}

let ctx: ReturnType<typeof makeChromeStorage>;

beforeEach(() => {
  ctx = makeChromeStorage();
  vi.stubGlobal('chrome', ctx.chrome);
  vi.stubGlobal('crypto', { randomUUID: () => 'uuid-fixed-1234' });
  vi.resetModules();
});

describe('loadConfig', () => {
  it('returns defaults when nothing is stored', async () => {
    const { loadConfig, DEFAULT_RELAY_URL } = await import('../background/connection-config');
    const config = await loadConfig();
    expect(config).toEqual({ relayUrl: DEFAULT_RELAY_URL, name: 'Chrome', enabled: true });
  });

  it('merges stored partial over defaults', async () => {
    const { loadConfig, CONFIG_STORAGE_KEY } = await import('../background/connection-config');
    ctx.store.set(CONFIG_STORAGE_KEY, { relayUrl: 'ws://custom/ws/browser', enabled: false });
    const config = await loadConfig();
    expect(config.relayUrl).toBe('ws://custom/ws/browser');
    expect(config.enabled).toBe(false);
    expect(config.name).toBe('Chrome'); // default retained
  });
});

describe('saveConfig', () => {
  it('persists a partial update merged with current', async () => {
    const { saveConfig, loadConfig } = await import('../background/connection-config');
    await saveConfig({ name: 'Work laptop', token: 'secret' });
    const config = await loadConfig();
    expect(config.name).toBe('Work laptop');
    expect(config.token).toBe('secret');
  });
});

describe('getOrCreateHandleId', () => {
  it('generates and persists a handle id once', async () => {
    const { getOrCreateHandleId } = await import('../background/connection-config');
    const first = await getOrCreateHandleId();
    const second = await getOrCreateHandleId();
    expect(first).toBe('uuid-fixed-1234');
    expect(second).toBe(first); // persisted, not regenerated
  });

  it('reuses an already-stored handle id', async () => {
    const { getOrCreateHandleId, HANDLE_ID_STORAGE_KEY } = await import('../background/connection-config');
    ctx.store.set(HANDLE_ID_STORAGE_KEY, 'pre-existing');
    expect(await getOrCreateHandleId()).toBe('pre-existing');
  });
});

describe('onConfigChanged', () => {
  it('fires with the merged config when the config key changes', async () => {
    const { onConfigChanged, saveConfig } = await import('../background/connection-config');
    const seen: Array<{ enabled: boolean }> = [];
    onConfigChanged((cfg) => seen.push(cfg));
    await saveConfig({ enabled: false });
    expect(seen.at(-1)?.enabled).toBe(false);
  });
});
