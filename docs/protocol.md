# BrowserHandle protocol

This document describes the wire protocol between the three moving parts:

```
agent ──HTTP──> relay ──WebSocket──> extension
```

Types live in [`@browserhandle/protocol`](../packages/protocol/src). The current protocol version is **1** (`PROTOCOL_VERSION`).

## Extension ↔ relay (WebSocket)

The extension dials the relay's browser endpoint:

```
ws(s)://<relay-host>/ws/browser
```

The relay only accepts WebSocket upgrades from extension origins (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) or no Origin header. In tokenless loopback mode, the `Host` header must also be a loopback address (DNS-rebinding protection).

### Registration handshake

The extension must send a `register` message as its first frame, within 5 seconds, or the relay closes the socket with code `4400`.

```jsonc
// extension -> relay
{
  "type": "register",
  "protocolVersion": 1,
  "handleId": "b7e4c1d2-…",     // stable UUID, persisted in chrome.storage.local
  "token": "…",                  // required iff the relay has a browser token
  "name": "Work laptop",         // user-facing label
  "meta": { "extensionVersion": "0.1.0", "userAgent": "…" }
}
```

The relay replies:

```jsonc
// relay -> extension (success)
{ "type": "registered", "handleId": "b7e4c1d2-…", "protocolVersion": 1, "relayVersion": "0.1.0" }

// relay -> extension (failure, followed by close)
{ "type": "relay-error", "code": "UNAUTHORIZED" | "PROTOCOL_MISMATCH" | "INVALID_REQUEST", "message": "…" }
```

If a second socket registers the same `handleId`, the older socket is closed with code `4409` (superseded). Reconnecting with the same `handleId` reattaches to the same handle.

### Close codes

| Code | Meaning |
|------|---------|
| `4400` | No/invalid register within the deadline, or protocol mismatch |
| `4401` | Browser token rejected |
| `4409` | Superseded by a newer connection for the same handle |

### Bridge messages

After registration the socket carries bridge messages — the raw browser commands. The relay sends `request` frames; the extension replies with an `ack` (liveness) and then a `response` or `error`, correlated by `id`:

```jsonc
// relay -> extension
{ "id": "uuid", "type": "request", "method": "click", "payload": { "ref": "@e3", "snapshotId": "snap-1" }, "timestamp": 0 }

// extension -> relay
{ "id": "uuid", "type": "ack",      "method": "click", "payload": {}, "timestamp": 0 }
{ "id": "uuid", "type": "response", "method": "click", "payload": { "success": true }, "timestamp": 0 }
// …or
{ "id": "uuid", "type": "error",    "method": "click", "payload": { "code": "STALE_SNAPSHOT", "message": "…" }, "timestamp": 0 }
```

The relay generates the `id`; agent-supplied ids are never trusted, which makes concurrent agents per handle safe. The relay heartbeats every 20s with a WebSocket ping; a missed pong terminates the socket.

### Methods

`navigate`, `snapshot`, `click`, `hover`, `typeText`, `selectOption`, `screenshot`, `newTab`, `listTabs`, `switchTab`, `closeTab`, `goBack`, `goForward`, `reload`, `waitForNavigation`, `scrollPage`, `dropFiles`, `handleDialog`, `evaluate`, `listWebMCPTools`, `invokeWebMCPTool`, `ping`.

Per-operation timeouts are defined in `OPERATION_TIMEOUTS`.

## Agent ↔ relay (HTTP)

| Method & path | Auth | Body | Result |
|---------------|------|------|--------|
| `GET /healthz` | none | — | `HealthInfo` (no handle ids) |
| `GET /v1/handles` | Bearer | — | `HandleInfo[]` |
| `POST /v1/handles/:id/call` | Bearer | `CallRequest` | `CallResponse` |

```jsonc
// CallRequest
{ "method": "navigate", "payload": { "url": "https://example.com" }, "timeoutMs": 30000 }

// CallResponse (success)
{ "ok": true, "result": { "url": "https://example.com/", "title": "Example Domain", "tabId": 42 } }

// CallResponse (failure)
{ "ok": false, "error": { "code": "STALE_SNAPSHOT", "message": "…" } }
```

### Status codes

Relay-level failures map to real HTTP status codes:

| Status | Code | Meaning |
|--------|------|---------|
| `401` | `UNAUTHORIZED` | Missing/invalid agent token |
| `404` | `HANDLE_NOT_FOUND` | No such handle id |
| `503` | `HANDLE_DISCONNECTED` | The handle is currently disconnected |
| `504` | `RELAY_TIMEOUT` | The browser did not answer in time |
| `429` | `RELAY_BUSY` | Too many in-flight calls for the handle |
| `400` / `413` | `INVALID_REQUEST` | Malformed body or oversized payload |

A request that the extension actually answered — **including bridge errors** like `STALE_SNAPSHOT` — always returns HTTP `200` with `{ ok: false, error }`. Only relay-level failures use non-200 statuses.

The maximum request/WebSocket payload is 32 MB (covers base64 `dropFiles` uploads).
