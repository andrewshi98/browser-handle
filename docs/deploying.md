# Deploying a remote relay

The relay is a single standalone process with no database and no per-user state — it keeps an in-memory registry of connected browser handles. You can run it anywhere an agent and a browser can both reach it.

## Tokens

The relay has two token surfaces:

- **`BROWSERHANDLE_BROWSER_TOKEN`** — the extension must present this in its `register` message.
- **`BROWSERHANDLE_AGENT_TOKEN`** — agents must present this as `Authorization: Bearer <token>` on the HTTP API.

`--token` (or `BROWSERHANDLE_TOKEN`) sets both at once. Keep them distinct in production so an agent credential can't impersonate a browser.

**Fail-closed:** binding to any non-loopback host without **both** tokens refuses to start. Tokenless operation is only allowed on a loopback bind (local development).

Prefer environment variables over flags — command-line flags are visible in `ps`.

## TLS

The relay speaks plain HTTP/WS and does **not** terminate TLS itself. Put it behind a reverse proxy that provides `https://` and `wss://` on one hostname.

### Caddy

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:18080
}
```

Caddy upgrades WebSocket connections automatically, so both `https://relay.example.com/v1/...` and `wss://relay.example.com/ws/browser` work through one block.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate ... ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

## Running the relay

### systemd

```ini
# /etc/systemd/system/browserhandle-relay.service
[Service]
Environment=BROWSERHANDLE_HOST=127.0.0.1
Environment=BROWSERHANDLE_PORT=18080
Environment=BROWSERHANDLE_AGENT_TOKEN=…
Environment=BROWSERHANDLE_BROWSER_TOKEN=…
ExecStart=/usr/bin/npx -y @browserhandle/relay
Restart=always

[Install]
WantedBy=multi-user.target
```

Bind to `127.0.0.1` and let the reverse proxy face the network. (If you bind the relay directly to `0.0.0.0`, both tokens are required.)

### Container

```dockerfile
FROM node:20-slim
RUN npm i -g @browserhandle/relay
ENV BROWSERHANDLE_HOST=0.0.0.0 BROWSERHANDLE_PORT=18080
EXPOSE 18080
CMD ["browserhandle-relay"]
```

Provide `BROWSERHANDLE_AGENT_TOKEN` and `BROWSERHANDLE_BROWSER_TOKEN` at runtime.

## Pointing the clients at it

- **Extension:** open the side panel → **Connection settings** → set the relay URL to `wss://relay.example.com/ws/browser` and the browser token. Status shows **Connected** once registered.
- **MCP adapter:** set `BROWSERHANDLE_RELAY_URL=https://relay.example.com` and `BROWSERHANDLE_AGENT_TOKEN=…`, or pass `--relay-url` / `--token`.

## Operational notes

- The registry is in-memory. Restarting the relay drops all handles; extensions reconnect and re-register the same `handleId` automatically.
- Disconnected handles linger as tombstones for 15 minutes (so a brief drop doesn't lose the binding), then are pruned.
- Logs are JSON lines on stderr: `relay_started`, `browser_connected`/`disconnected`, `browser_superseded`, `call`, `auth_failed`. Tokens and payloads are never logged.
- `GET /healthz` is unauthenticated and leaks no handle ids — safe for load-balancer health checks.
