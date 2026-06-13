/**
 * BrowserHandle Chrome Extension Service Worker.
 *
 * Acts as the message hub between:
 * - WebSocket (MCP Server) ↔ Content Scripts (page interaction)
 * - Content Scripts ↔ Side Panel (activity logging)
 */
import {
  WEBSOCKET_DEFAULT_PORT,
  WEBSOCKET_PORT_RANGE_SIZE,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_ALARM,
  CONTENT_CHANNEL,
  SIDE_PANEL_PREFIX,
  SIDE_PANEL_UPDATE_CHANNEL,
} from '@browserhandle/protocol';
import { WebSocketBridge } from './ws-bridge';
import { TabManager } from './tab-manager';
import { MessageRouter } from './message-router';
import { DialogHandler } from './dialog-handler';

// --- State ---
const tabManager = new TabManager();
const messageRouter = new MessageRouter(tabManager);
const dialogHandler = new DialogHandler();
messageRouter.setDialogHandler(dialogHandler);

const wsBridges: WebSocketBridge[] = [];
for (let i = 0; i < WEBSOCKET_PORT_RANGE_SIZE; i++) {
  wsBridges.push(
    new WebSocketBridge(
      `ws://127.0.0.1:${WEBSOCKET_DEFAULT_PORT + i}`,
      messageRouter,
    ),
  );
}

/** Backward-compatible single bridge reference (first port) */
const wsBridge = wsBridges[0];

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

// --- Content Script Messages ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.channel === CONTENT_CHANNEL) {
    messageRouter.handleContentScriptMessage(message, sender, sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.channel === SIDE_PANEL_PREFIX) {
    // Forward to side panel
    broadcastToSidePanel(message);
    sendResponse({ ok: true });
    return false;
  }
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

export { messageRouter, tabManager, wsBridge, wsBridges, broadcastToSidePanel };
