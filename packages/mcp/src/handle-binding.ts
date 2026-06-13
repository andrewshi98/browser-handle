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
import { BrowserHandleError } from '@browserhandle/client';
import type { BrowserHandleClient } from '@browserhandle/client';
import type { BrowserTransport } from './transport.js';

/** A clear, no-handle-available condition carrying a recovery message. */
class NoHandleError extends Error {}

export class HandleBinding implements BrowserTransport {
  private boundHandleId: string | null;
  /** True when bound via --handle: never auto-switch away from it. */
  private explicit: boolean;
  /** Memoizes an in-flight auto-bind so concurrent first calls share it. */
  private bindingPromise: Promise<string> | null = null;

  constructor(
    private readonly client: BrowserHandleClient,
    options: { handleId?: string } = {}
  ) {
    this.boundHandleId = options.handleId ?? null;
    this.explicit = options.handleId !== undefined;
  }

  getBoundHandleId(): string | null {
    return this.boundHandleId;
  }

  selectHandle(handleId: string): void {
    this.boundHandleId = handleId;
    this.explicit = true;
    this.bindingPromise = null;
  }

  listHandles(): Promise<HandleInfo[]> {
    return this.client.listHandles();
  }

  async requestWithRetry(method: BridgeMethod, payload: unknown = {}): Promise<BridgeMessage> {
    return this.attempt(method, payload, false);
  }

  private async attempt(
    method: BridgeMethod,
    payload: unknown,
    isRetry: boolean
  ): Promise<BridgeMessage> {
    let handleId: string;
    try {
      handleId = await this.resolveHandle();
    } catch (err) {
      // Preserve a relay error code (e.g. UNAUTHORIZED) rather than masking it.
      if (err instanceof BrowserHandleError) {
        return toErrorMessage(method, err.code, err.message);
      }
      if (err instanceof NoHandleError) {
        return toErrorMessage(method, 'HANDLE_NOT_FOUND', err.message);
      }
      return toErrorMessage(method, 'HANDLER_ERROR', err instanceof Error ? err.message : String(err));
    }

    const response = await this.client.call(handleId, method, payload);

    // Auto-recovery: an auto-bound handle that has disconnected is unbound so
    // the next resolve re-selects a connected handle. Bounded to one retry,
    // and never overrides an explicit --handle binding.
    if (
      !isRetry &&
      !this.explicit &&
      !response.ok &&
      response.error.code === 'HANDLE_DISCONNECTED'
    ) {
      this.boundHandleId = null;
      return this.attempt(method, payload, true);
    }

    return toBridgeMessage(method, response);
  }

  /** Resolve the handle to use, auto-binding when unambiguous. */
  private resolveHandle(): Promise<string> {
    if (this.boundHandleId) return Promise.resolve(this.boundHandleId);
    // Share a single in-flight auto-bind across concurrent first calls.
    if (this.bindingPromise) return this.bindingPromise;

    this.bindingPromise = this.autoBind().finally(() => {
      this.bindingPromise = null;
    });
    return this.bindingPromise;
  }

  private async autoBind(): Promise<string> {
    const handles = await this.client.listHandles();
    const connected = handles.filter((h) => h.connected);

    if (connected.length === 1) {
      this.boundHandleId = connected[0].handleId;
      return this.boundHandleId;
    }

    if (connected.length === 0) {
      throw new NoHandleError(
        'No browser handle is connected to the relay. Open Chrome with the BrowserHandle ' +
          'extension and confirm it shows "Connected" in the side panel, then retry. ' +
          'Use list_browser_handles to inspect the relay.'
      );
    }

    const labels = connected.map((h) => `${h.handleId} ("${h.name}")`).join(', ');
    throw new NoHandleError(
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
