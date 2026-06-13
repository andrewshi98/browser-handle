# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - Unreleased

Initial release. Derived from [WebClaw](https://github.com/kuroko1t/webclaw)
(commit `fa67f87`) under the MIT License and reshaped around a relay-based
architecture.

### Added

- **Relay** (`@browserhandle/relay`): standalone server with an in-memory handle
  registry, a `/ws/browser` WebSocket endpoint for extensions, and an HTTP agent
  API (`GET /healthz`, `GET /v1/handles`, `POST /v1/handles/:id/call`). Token auth
  on both surfaces, loopback-tokenless mode, fail-closed startup on non-loopback
  binds, per-handle in-flight cap, and tombstone pruning.
- **Client** (`@browserhandle/client`): typed HTTP client for the agent API with
  transient-failure retry.
- **MCP adapter** (`@browserhandle/mcp`): stdio MCP server that forwards 21
  browser-control tools to a handle through the relay, plus `list_browser_handles`
  and `select_browser_handle`. Lazy, sticky handle binding (auto-selects a single
  connected handle).
- **Extension** (`@browserhandle/extension`): dials a single configurable relay URL
  with a register handshake, exponential-backoff reconnect, and a persisted
  `browser_handle_id`. Side-panel connection settings and live status; deferred
  `PolicyGate` enforcement seam.
- **Protocol** (`@browserhandle/protocol`): shared bridge + relay wire types, Zod
  schemas, error codes, and constants.

### Changed from WebClaw

- Inverted the topology: the extension now dials a relay instead of the MCP server
  hosting a WebSocket server and scanning ports 18080–18089.
- Removed Chrome auto-launch (the adapter may run far from any browser).

### Documentation

- `docs/protocol.md`, `docs/deploying.md`, `docs/security.md`.
