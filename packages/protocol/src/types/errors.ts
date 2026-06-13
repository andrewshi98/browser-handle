/**
 * Error codes and recovery messages for BrowserHandle.
 */

/** Standard error codes used across the bridge protocol */
export type ErrorCode =
  | 'CONNECTION_LOST'
  | 'TAB_NOT_FOUND'
  | 'STALE_SNAPSHOT'
  | 'NAVIGATION_TIMEOUT'
  | 'NO_ACTIVE_TAB'
  | 'UNKNOWN_METHOD'
  | 'HANDLER_ERROR'
  | 'CONTENT_SCRIPT_ERROR'
  | 'SCREENSHOT_FAILED'
  | 'DIALOG_NOT_FOUND'
  // Relay-level errors
  | 'HANDLE_NOT_FOUND'
  | 'HANDLE_DISCONNECTED'
  | 'UNAUTHORIZED'
  | 'RELAY_TIMEOUT'
  | 'PROTOCOL_MISMATCH'
  | 'RELAY_BUSY'
  | 'INVALID_REQUEST'
  // Reserved for the extension-side policy gate (no enforcement yet)
  | 'POLICY_DENIED';

/** Map of error codes to human-readable recovery suggestions */
export const ERROR_RECOVERY: Record<ErrorCode, string> = {
  CONNECTION_LOST:
    'The connection to the Chrome extension was lost. It should reconnect automatically. If not, try reloading the extension.',
  TAB_NOT_FOUND:
    'The specified tab was not found. Use list_tabs to see available tabs.',
  STALE_SNAPSHOT:
    'The snapshot is stale because the page has changed. Take a new page_snapshot before interacting with elements.',
  NAVIGATION_TIMEOUT:
    'Navigation timed out. The page may still be loading. Try wait_for_navigation or reload.',
  NO_ACTIVE_TAB:
    'No active tab found. Use new_tab to open a page or list_tabs to check available tabs.',
  UNKNOWN_METHOD:
    'The requested method is not supported. Check the tool name and try again.',
  HANDLER_ERROR:
    'An internal error occurred while processing the request. Try again or take a new snapshot. If a browser dialog is blocking, use handle_dialog to dismiss it first.',
  CONTENT_SCRIPT_ERROR:
    'The content script encountered an error. Try reloading the page and taking a new snapshot.',
  SCREENSHOT_FAILED:
    'Failed to capture a screenshot. Ensure the tab is visible and not a chrome:// page.',
  DIALOG_NOT_FOUND:
    'No JavaScript dialog (alert/confirm/prompt) was detected on this tab. The dialog may have already been dismissed.',
  HANDLE_NOT_FOUND:
    'No browser handle with that ID is registered on the relay. Use list_browser_handles to see available handles.',
  HANDLE_DISCONNECTED:
    'The browser handle is currently disconnected. It reconnects automatically when the browser is running - retry shortly, or check list_browser_handles.',
  UNAUTHORIZED:
    'The relay rejected the credentials. Check the configured token.',
  RELAY_TIMEOUT:
    'The browser did not answer within the operation timeout. The page may be busy or blocked by a dialog - try again or use handle_dialog.',
  PROTOCOL_MISMATCH:
    'The extension and relay speak different protocol versions. Update the extension and relay to matching releases.',
  RELAY_BUSY:
    'Too many requests are already in flight for this handle. Wait for pending operations to finish and retry.',
  INVALID_REQUEST:
    'The request was malformed. Check the method name and payload against the protocol documentation.',
  POLICY_DENIED:
    'The browser-side policy gate denied this action.',
};
