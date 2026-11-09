# Deployment

[Architecture and credentials](architecture.md) describes the two services and their trust boundaries. The steps here use DSH as the client. A harness with a Streamable HTTP MCP client can use the same capability endpoint.

## Hosted deployment

Run the two gateway services and the HTTPS ingress on a server you manage, such as a VPS. Clients can run on another machine. For local use, the quick start connects directly to the loopback endpoints.

| Public route | Private listener | Service |
| --- | --- | --- |
| `https://gateway.example.com/v1` and its subpaths | `127.0.0.1:8317` | CLIProxyAPI Model Proxy |
| `https://gateway.example.com/mcp` | `127.0.0.1:8318` | oh-my-harness Capability Proxy |

1. On the gateway host, follow the initialization and provider login steps in the [quick start](../README.md#start-with-dsh). Start CLIProxyAPI with `npm run proxy`. Its generated configuration binds to loopback HTTP and sets client keys. For your own configuration, set `server.host` to `127.0.0.1`, populate `access.api-keys`, and let the ingress terminate HTTPS.
2. Set `upstream` in `.state/config.json` to `http://127.0.0.1:8317/v1`. Set `listen.publicOrigin` to `https://gateway.example.com`, then run `npm start` for the Capability Proxy.
3. Point your domain at the gateway host and use one HTTPS ingress. Choose [Caddy](../deploy/Caddyfile.example) or [NGINX](../deploy/nginx.conf.example). For NGINX, include the template in the `http` context and set the certificate paths. The ingress preserves the path and sends the configured public hostname to the Capability Proxy. Keep both backend ports private.

The templates route the exact `/mcp` path and the `/v1` namespace separately. The NGINX template disables response buffering for SSE and forwards WebSocket upgrade headers. For separate hostnames, create one site or server block per route on the same ingress. Set `listen.publicOrigin` to the HTTPS origin of the capability hostname. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) · [NGINX WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)

## Connect DSH

On the DSH machine, install oh-my-harness dependencies with `npm ci`. Match the local provider IDs and model aliases to your deployment. Use the two client key files from your deployment.

```sh
export OH_MY_HARNESS_MODEL_URL=https://gateway.example.com/v1
export OH_MY_HARNESS_MODEL_KEY_FILE=/path/to/model.key
export OH_MY_HARNESS_MCP_URL=https://gateway.example.com/mcp
export OH_MY_HARNESS_KEY_FILE=/path/to/gateway.key

npm run doctor -- --models
npm run doctor
npm run dsh
```

The DSH launcher uses the pinned `@deepseek-ai/dsh` Web profile or the executable specified by `OH_MY_HARNESS_DSH_BIN`. It renders a profile under the local oh-my-harness state directory. Set `OH_MY_HARNESS_WORKSPACE` to choose where DSH and the file adapter work.

The model check reports advertised IDs and any missing configured text models. The capability check lists MCP tools using the capability key. For an upstream error from an individual tool, check the selected provider, model and capability against the authorized account. [Provider configuration](providers.md)

Other clients can connect directly to the Model Proxy and Capability Proxy with their respective protocols and keys. dsh-go users can connect to the DSH host using the app's remote connection setup. Configure both endpoints on that host. [dsh-go](https://github.com/ccch1mneyyy/dsh-Go)

For an existing DSH deployment, keep your profile and point its MCP client or file adapter at the Capability Proxy. The [optional Codex native extension](../extensions/dsh-native-codex/README.md) adds search citations and image attachments directly to a DSH Responses provider. The same tools remain available over MCP, including for conversations using another provider.

[DSH native extension development](../extensions/dsh-native/README.md) describes the shared release format and how to add a provider-specific plugin.

## Reuse an existing CLIProxyAPI

Set `upstream` to the existing CLIProxyAPI URL ending in `/v1` and set `OH_MY_HARNESS_UPSTREAM_KEY_FILE` to a CLIProxyAPI client key file. Use HTTPS for remote connections or HTTP over loopback. `npm run init` creates the local capability key for an external upstream. Start the Capability Proxy with `npm start`. Supply the existing model client key separately when launching DSH. For a locally managed CLIProxyAPI config of your own, set `CLIPROXY_CONFIG`. [CLIProxyAPI v8 configuration](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.51/config.example.yaml)

The current `upstream` setting configures the CLIProxyAPI adapter. A direct independent harness connection requires its own adapter. [Extension workflow](providers.md#extend-capabilities)

If upgrading a generated configuration that shared one client key, stop CLIProxyAPI and rerun `npm run init`. This creates the model key, updates `access.api-keys`, and retains the OAuth directory. For a custom config, set separate client keys explicitly. Legacy `OH_MY_DSH_*` settings remain accepted. Use `OH_MY_HARNESS_MODEL_URL` and `OH_MY_HARNESS_MCP_URL` for the two client routes.

| Setting | Purpose |
| --- | --- |
| `OH_MY_HARNESS_MODEL_URL` | Model API URL ending in `/v1`. Defaults to the configured upstream. |
| `OH_MY_HARNESS_MODEL_KEY_FILE` | Model client key file. Defaults to `.state/model.key`. |
| `OH_MY_HARNESS_MCP_URL` | Capability Proxy URL ending in `/mcp`. Defaults to the local listener. |
| `OH_MY_HARNESS_KEY_FILE` | Capability key file. Defaults to `.state/gateway.key`. |
| `OH_MY_HARNESS_UPSTREAM_KEY_FILE` | CLIProxyAPI client key for capability calls. Defaults to the model key file. |
| `OH_MY_HARNESS_STATE_DIR` | Runtime state root. Defaults to `.state` in the checkout. |
| `OH_MY_HARNESS_CONFIG` | Config JSON file. Defaults to `.state/config.json`, then the bundled defaults. |
| `OH_MY_HARNESS_WORKSPACE` | DSH workspace. Defaults to the `workspace/` subdirectory of runtime state. |
| `OH_MY_HARNESS_DSH_BIN` | Optional path to a DSH executable. |
| `CLIPROXY_BIN` / `CLIPROXY_CONFIG` | Executable or configuration path for `npm run proxy`. |
