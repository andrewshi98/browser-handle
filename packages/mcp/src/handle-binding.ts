/**
 * Resolves which browser handle this MCP session controls.
 *
 * Binding is lazy and sticky:
 *   - an explicit --handle / BROWSERHANDLE_HANDLE_ID wins and never changes
 *     until select_browser_handle is called;
 *   - otherwise, on the first tool call, auto-bind iff exactly one handle is
 *     connected; zero or many connected handles produce an instructive error
 *     that points at list_browser_handles / select_browser_handle.
 */
import { createMessageId } from '@browserhandle/protocol';
import type { BridgeMessage, BridgeMethod, CallResponse, HandleInfo } from '@browserhandle/protocol';
import type { BrowserHandleClient } from '@browserhandle/client';
import type { BrowserTransport } from './transport.js';

export class HandleBinding implements BrowserTransport {
  private boundHandleId: string | null;

  constructor(
    private readonly client: BrowserHandleClient,
    options: { handleId?: string } = {}
  ) {
    this.boundHandleId = options.handleId ?? null;
  }

  getBoundHandleId(): string | null {
    return this.boundHandleId;
  }

  selectHandle(handleId: string): void {
    this.boundHandleId = handleId;
  }

  listHandles(): Promise<HandleInfo[]> {
    return this.client.listHandles();
  }

  async requestWithRetry(method: BridgeMethod, payload: unknown = {}): Promise<BridgeMessage> {
    let handleId: string;
    try {
      handleId = await this.resolveHandle();
    } catch (err) {
      return toErrorMessage(method, 'HANDLE_NOT_FOUND', err instanceof Error ? err.message : String(err));
    }
    const response = await this.client.call(handleId, method, payload);
    return toBridgeMessage(method, response);
  }

  /** Resolve the handle to use, auto-binding when unambiguous. */
  private async resolveHandle(): Promise<string> {
    if (this.boundHandleId) return this.boundHandleId;

    const handles = await this.client.listHandles();
    const connected = handles.filter((h) => h.connected);

    if (connected.length === 1) {
      this.boundHandleId = connected[0].handleId;
      return this.boundHandleId;
    }

    if (connected.length === 0) {
      throw new Error(
        'No browser handle is connected to the relay. Open Chrome with the BrowserHandle ' +
          'extension and confirm it shows "Connected" in the side panel, then retry. ' +
          'Use list_browser_handles to inspect the relay.'
      );
    }

    const labels = connected.map((h) => `${h.handleId} ("${h.name}")`).join(', ');
    throw new Error(
      `Multiple browser handles are connected: ${labels}. ` +
        'Use select_browser_handle to choose one, or start browserhandle-mcp with --handle.'
    );
  }
}

/** Map the relay's CallResponse envelope into the BridgeMessage shape. */
function toBridgeMessage(method: BridgeMethod, response: CallResponse): BridgeMessage {
  if (response.ok) {
    return {
      id: createMessageId(),
      type: 'response',
      method,
      payload: response.result,
      timestamp: Date.now(),
    };
  }
  return {
    id: createMessageId(),
    type: 'error',
    method,
    payload: response.error,
    timestamp: Date.now(),
  };
}

function toErrorMessage(method: BridgeMethod, code: string, message: string): BridgeMessage {
  return {
    id: createMessageId(),
    type: 'error',
    method,
    payload: { code, message },
    timestamp: Date.now(),
  };
}
