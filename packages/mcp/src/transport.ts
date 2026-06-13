/**
 * Transport interface consumed by the MCP server.
 *
 * The server speaks bridge methods and reads BridgeMessage responses; it does
 * not know about handles or HTTP. HandleBinding implements this over a
 * BrowserHandleClient, mapping the relay's CallResponse envelope back into the
 * BridgeMessage shape the 21 tools already expect.
 */
import type { BridgeMessage, BridgeMethod, HandleInfo } from '@browserhandle/protocol';

export interface BrowserTransport {
  /** Invoke a bridge method on the bound handle, with transient retry. */
  requestWithRetry(method: BridgeMethod, payload?: unknown): Promise<BridgeMessage>;
  /** List all handles registered on the relay. */
  listHandles(): Promise<HandleInfo[]>;
  /** The currently bound handle id, or null if none is bound yet. */
  getBoundHandleId(): string | null;
  /** Bind to a specific handle (used by select_browser_handle). */
  selectHandle(handleId: string): void;
}
