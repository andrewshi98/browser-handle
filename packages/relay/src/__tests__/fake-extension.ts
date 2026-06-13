/**
 * Test double for the Chrome extension side of the relay protocol:
 * a plain `ws` client that registers a handle and answers bridge
 * requests (ack + method-aware response), like ws-bridge.ts does.
 */
import WebSocket from 'ws';
import { BROWSER_WS_PATH, PROTOCOL_VERSION } from '@browserhandle/protocol';
import type {
  BridgeRequest,
  RegisteredMessage,
  RegisterMessage,
  RelayErrorMessage,
} from '@browserhandle/protocol';

export interface FakeExtensionOptions {
  handleId: string;
  name?: string;
  token?: string;
  protocolVersion?: number;
  /** Send the register message automatically on open (default true) */
  autoRegister?: boolean;
  /**
   * Compute the response payload for a request. Return a promise to
   * delay the answer. Throwing sends a bridge error frame.
   */
  respond?: (request: BridgeRequest) => unknown | Promise<unknown>;
  /** Swallow requests without answering (timeout testing) */
  mute?: boolean;
}

export class FakeExtension {
  readonly ws: WebSocket;
  readonly requests: BridgeRequest[] = [];
  readonly relayErrors: RelayErrorMessage[] = [];
  readonly registered: Promise<RegisteredMessage>;
  readonly closed: Promise<{ code: number; reason: string }>;
  mute: boolean;

  private respondFn: (request: BridgeRequest) => unknown | Promise<unknown>;

  constructor(port: number, private options: FakeExtensionOptions) {
    this.mute = options.mute ?? false;
    this.respondFn =
      options.respond ?? ((request) => ({ echo: request.method, handleId: options.handleId }));

    this.ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_WS_PATH}`);

    let resolveRegistered: (m: RegisteredMessage) => void;
    this.registered = new Promise((resolve) => {
      resolveRegistered = resolve;
    });

    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    this.ws.on('open', () => {
      if (options.autoRegister !== false) this.register();
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'registered') {
        resolveRegistered(message as RegisteredMessage);
        return;
      }
      if (message.type === 'relay-error') {
        this.relayErrors.push(message as RelayErrorMessage);
        return;
      }
      if (message.type === 'request') {
        void this.handleRequest(message as BridgeRequest);
      }
    });
  }

  register(overrides: Partial<RegisterMessage> = {}): void {
    const message: RegisterMessage = {
      type: 'register',
      protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
      handleId: this.options.handleId,
      token: this.options.token,
      name: this.options.name,
      meta: { extensionVersion: 'test' },
      ...overrides,
    };
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }

  private async handleRequest(request: BridgeRequest): Promise<void> {
    this.requests.push(request);
    if (this.mute) return;

    this.sendRaw({
      id: request.id,
      type: 'ack',
      method: request.method,
      payload: {},
      timestamp: Date.now(),
    });

    try {
      const payload = await this.respondFn(request);
      this.sendRaw({
        id: request.id,
        type: 'response',
        method: request.method,
        payload,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.sendRaw({
        id: request.id,
        type: 'error',
        method: request.method,
        payload: {
          code: 'HANDLER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
    }
  }
}

/** Connect and wait until the relay confirms registration */
export async function connectFakeExtension(
  port: number,
  options: FakeExtensionOptions
): Promise<FakeExtension> {
  const extension = new FakeExtension(port, options);
  await extension.registered;
  return extension;
}
