# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- Initial release. Imported from [WebClaw](https://github.com/kuroko1t/webclaw)
  (commit `fa67f87`) under the MIT License and renamed to BrowserHandle.
- Restructured into `protocol` / `relay` / `client` / `mcp` / `extension` packages
  around a relay-based architecture: the Chrome extension dials a configured relay
  URL (local or remote), the relay registers a `browser_handle_id`, and agents
  control handles through the relay's HTTP API or the MCP adapter.
