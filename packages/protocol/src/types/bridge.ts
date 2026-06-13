/**
 * Bridge message protocol between the relay and the Chrome extension.
 * Messages are JSON frames exchanged over a WebSocket connection.
 */

export type BridgeMessageType = 'request' | 'response' | 'ack' | 'error';

/** Base bridge message */
export interface BridgeMessage {
  id: string;
  type: BridgeMessageType;
  method: string;
  payload: unknown;
  timestamp: number;
}

/** Request from relay to Extension */
export interface BridgeRequest extends BridgeMessage {
  type: 'request';
}

/** Successful response from Extension to relay */
export interface BridgeResponse extends BridgeMessage {
  type: 'response';
}

/** Acknowledgment of request receipt */
export interface BridgeAck extends BridgeMessage {
  type: 'ack';
}

/** Error response */
export interface BridgeError extends BridgeMessage {
  type: 'error';
  payload: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** All bridge method names, as a runtime list (used for validation) */
export const BRIDGE_METHODS = [
  'navigate',
  'snapshot',
  'click',
  'hover',
  'typeText',
  'selectOption',
  'listWebMCPTools',
  'invokeWebMCPTool',
  'screenshot',
  'ping',
  'newTab',
  'listTabs',
  'switchTab',
  'closeTab',
  'goBack',
  'goForward',
  'reload',
  'waitForNavigation',
  'scrollPage',
  'dropFiles',
  'handleDialog',
  'evaluate',
] as const;

/** All bridge method names for type-safe dispatch */
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];
