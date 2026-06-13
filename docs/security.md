# Security model

BrowserHandle connects agents to your **real, logged-in browser**. Treat a connected handle as equivalent to handing an agent your browser session. This document states what v1 protects against, what it does not, and where the enforcement seams are.

## Threat model

The relay sits between agents and browsers. Its job is to (a) authenticate both sides, (b) route calls to the right handle, and (c) not leak across handles.

| Concern | v1 posture |
|---------|-----------|
| Unauthenticated agents | Blocked when an agent token is set (HTTP `401`). Disabled only on a tokenless loopback bind. |
| Unauthenticated browsers | Blocked when a browser token is set (WS close `4401`). |
| Remote exposure without auth | The relay refuses to start on a non-loopback host unless **both** tokens are set. |
| DNS rebinding (tokenless local) | WebSocket upgrades require a loopback `Host`; web-page origins (`http(s)://`) are rejected. |
| Cross-handle leakage | Each handle has its own socket and pending-call map; the relay generates call ids, so one agent cannot resolve another's calls. |
| Handle impersonation | Browser and agent tokens are separate; an agent credential cannot register as a browser. |
| Resource exhaustion | Per-handle in-flight cap (`RELAY_BUSY`), 32 MB payload cap, 15-minute tombstone pruning. |
| Token theft via logs | Tokens are never written to logs; comparisons are constant-time. |

## What v1 does NOT do

- **No permission enforcement.** Any agent that can reach the relay with a valid token can drive any connected browser with the full tool set. There is no per-origin allow/deny list, no per-tool gating, and no interactive approval.
- **No in-process TLS.** Run the relay behind a reverse proxy for `wss://`/`https://` (see [deploying.md](deploying.md)).
- **No audit trail beyond logs.** The side panel shows a live activity log; it is not persisted.

If you expose a relay on a network, the tokens are the entire access-control story. Rotate them if leaked, and prefer a per-deployment browser token and per-agent agent token.

## The policy-gate seam (deferred enforcement)

The codebase is structured so enforcement can be added without re-architecting. Two seams exist:

1. **Extension-side `PolicyGate`** — [`packages/extension/src/background/policy-gate.ts`](../packages/extension/src/background/policy-gate.ts). `MessageRouter.handleBridgeRequest` calls `policyGate.check({ method, payload, tabId })` exactly once, before dispatch. The default `AllowAllPolicyGate` permits everything; a denial returns the reserved `POLICY_DENIED` error. This is the closest point to the user and sees full tab context — the natural home for origin allow/deny lists, tool-category gates, and interactive approve-once/always prompts in the side panel.

2. **Relay-side routing** — `HandleRegistry.call` is where a future relay-side policy (per-agent-token scopes, rate limits) would attach, complementing the browser-side gate for remote deployments.

Neither seam enforces anything in v1, by design. They are documented here so a v2 has a clear, single place to add policy.

## Recommendations

- Keep the relay bound to `127.0.0.1` and face the network only through a reverse proxy.
- Use distinct, high-entropy browser and agent tokens; never reuse `--token` across trust boundaries in production.
- Only connect agents you trust to drive your logged-in sessions — until policy enforcement lands, a handle is unrestricted browser access.
