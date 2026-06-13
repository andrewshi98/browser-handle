/**
 * Shared constants for BrowserHandle.
 */

/** Service Worker keepalive interval in ms (25 seconds, under 30s limit) */
export const KEEPALIVE_INTERVAL_MS = 25_000;

/** chrome.alarms name used to keep the MV3 service worker alive */
export const KEEPALIVE_ALARM = 'browserhandle-keepalive';

/** chrome.runtime channel: service worker → content script commands */
export const ACTION_CHANNEL = 'browserhandle-action';

/** chrome.runtime channel: content script → service worker messages */
export const CONTENT_CHANNEL = 'browserhandle-content';

/** Content script ↔ page context message channel */
export const PAGE_BRIDGE_CHANNEL = 'browserhandle-page-bridge';

/** Side panel message type prefix */
export const SIDE_PANEL_PREFIX = 'browserhandle-sidepanel';

/** chrome.runtime channel: service worker → side panel activity updates */
export const SIDE_PANEL_UPDATE_CHANNEL = 'browserhandle-sidepanel-update';

/** chrome.runtime channel: service worker → side panel relay connection status */
export const STATUS_CHANNEL = 'browserhandle-status';

/** chrome.runtime channel: side panel → service worker, request current status */
export const STATUS_REQUEST_CHANNEL = 'browserhandle-status-request';

/** Default WebSocket port for MCP ↔ Extension communication */
export const WEBSOCKET_DEFAULT_PORT = 18080;

/** Number of ports to scan for multi-session support (18080–18089) */
export const WEBSOCKET_PORT_RANGE_SIZE = 10;

/** Environment variable to override the WebSocket port */
export const WEBSOCKET_PORT_ENV = 'BROWSERHANDLE_PORT';

/** Operation-specific timeouts in milliseconds */
export const OPERATION_TIMEOUTS: Record<string, number> = {
  navigate: 30_000,
  newTab: 30_000,
  goBack: 30_000,
  goForward: 30_000,
  reload: 30_000,
  waitForNavigation: 30_000,
  snapshot: 15_000,
  click: 10_000,
  hover: 10_000,
  typeText: 10_000,
  selectOption: 10_000,
  screenshot: 15_000,
  listTabs: 5_000,
  switchTab: 5_000,
  closeTab: 5_000,
  listWebMCPTools: 10_000,
  invokeWebMCPTool: 30_000,
  scrollPage: 10_000,
  dropFiles: 30_000,
  handleDialog: 10_000,
  evaluate: 30_000,
  ping: 5_000,
};

/** Maximum number of retry attempts for transient failures */
export const MAX_RETRY_ATTEMPTS = 2;

/** Base delay in ms for exponential backoff between retries */
export const RETRY_BASE_DELAY_MS = 500;
