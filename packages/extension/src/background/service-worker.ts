/**
 * BrowserHandle Chrome Extension Service Worker.
 *
 * Hub between the relay (one outbound WebSocket) and the page (content
 * scripts), plus the side panel (activity log + connection settings).
 */
import {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_ALARM,
  CONTENT_CHANNEL,
  SIDE_PANEL_PREFIX,
  SIDE_PANEL_UPDATE_CHANNEL,
  STATUS_CHANNEL,
  STATUS_REQUEST_CHANNEL,
} from '@browserhandle/protocol';
import { TabManager } from './tab-manager';
import { MessageRouter } from './message-router';
import { DialogHandler } from './dialog-handler';
import { RelayConnection } from './relay-connection';
import type { RelayConnectionStatus } from './relay-connection';
import { loadConfig, getOrCreateHandleId, onConfigChanged } from './connection-config';

// --- State ---
const tabManager = new TabManager();
const messageRouter = new MessageRouter(tabManager);
const dialogHandler = new DialogHandler();
messageRouter.setDialogHandler(dialogHandler);

let relayConnection: RelayConnection | null = null;
let lastStatus: RelayConnectionStatus | null = null;

// --- Relay connection ---
async function initRelay(): Promise<void> {
  const [config, handleId] = await Promise.all([loadConfig(), getOrCreateHandleId()]);
  relayConnection = new RelayConnection(config, handleId, messageRouter, (status) => {
    lastStatus = status;
    chrome.runtime.sendMessage({ channel: STATUS_CHANNEL, status }).catch(() => {
      // Side panel may not be open.
    });
  });
  relayConnection.start();

  // Side panel edits chrome.storage.local directly; redial on changes.
  onConfigChanged((cfg) => relayConnection?.updateConfig(cfg));
}
void initRelay();

// --- Keepalive ---
chrome.alarms.create(KEEPALIVE_ALARM, {
  periodInMinutes: KEEPALIVE_INTERVAL_MS / 60_000,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Keep service worker alive by performing a trivial operation
    void chrome.storage.session.get('keepalive');
  }
});

// --- Content Script & Side Panel Messages ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.channel === CONTENT_CHANNEL) {
    messageRouter.handleContentScriptMessage(message, sender, sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.channel === SIDE_PANEL_PREFIX) {
    broadcastToSidePanel(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.channel === STATUS_REQUEST_CHANNEL) {
    sendResponse({ status: lastStatus ?? relayConnection?.getStatus() ?? null });
    return false;
  }

  return undefined;
});

// --- Side Panel ---
function broadcastToSidePanel(message: unknown): void {
  chrome.runtime.sendMessage({ channel: SIDE_PANEL_UPDATE_CHANNEL, ...message as object }).catch(() => {
    // Side panel may not be open
  });
}

// --- Tab Events ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // Clear stale dialog state on navigation
    dialogHandler.onTabNavigated(tabId);
  }
  if (changeInfo.status === 'complete') {
    tabManager.onTabReady(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabManager.onTabRemoved(tabId);
  dialogHandler.onTabRemoved(tabId);
});

// --- Side Panel Setup ---
chrome.sidePanel?.setOptions({
  enabled: true,
}).catch(() => {
  // sidePanel API may not be available
});

// --- Action Click → open side panel ---
chrome.action?.onClicked?.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel?.open({ tabId: tab.id }).catch(console.error);
  }
});

// --- Startup ---
console.log('[BrowserHandle] Service Worker started');

export { messageRouter, tabManager, broadcastToSidePanel };
