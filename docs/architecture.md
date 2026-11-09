# Architecture

oh-my-harness exposes upstream capabilities as Streamable HTTP MCP tools for any compatible harness or agent. The DSH quickstart is a client example. [Architecture diagram](architecture.png) · [Machine-readable architecture](architecture.json)

| Component | Responsibility | Entry point |
| --- | --- | --- |
| CLIProxyAPI | Provider login, model catalog, protocol translation, and upstream routing | `npm run proxy` launches the external CLIProxyAPI executable. Clients use its `/v1` API. |
| Capability Proxy | Tool discovery, input validation, provider-specific calls, and MCP results | `npm start` starts oh-my-harness. Clients use its `/mcp` endpoint. |
| DSH client integration | Client configuration and MCP file conversion for DSH sessions | `npm run dsh` starts DSH Web and configures both endpoints. |
| HTTPS ingress | TLS and public routing in a hosted deployment | Caddy or NGINX routes model and MCP traffic to their respective loopback listeners on the gateway host. |

DSH sends conversation requests to CLIProxyAPI and tool requests to the Capability Proxy. The two paths can use different sources. For example, a conversation can use Kimi while its search tool uses Codex.

The optional native extension is installed on the DSH host and loaded by its Web profile. It registers an adapter for the selected Codex provider, sends Responses requests through the configured Model Proxy, and turns provider events into DSH citations, replay state, and image attachments. The diagram shows the standard MCP integration. [DSH native extensions](../extensions/dsh-native/README.md)

| Capability upstream | Route | Status |
| --- | --- | --- |
| Provider-native tools | Capability Proxy calls CLIProxyAPI, which routes the request to the authorized provider | Included in the current release |
| Independent harness tools | A dedicated adapter calls the harness's MCP or HTTP tool interface directly from the Capability Proxy | Extension path that requires an adapter |

The included Codex search route requests a native Responses tool and the Kimi search route uses the Messages server tool. Search results are checked against upstream tool actions or result blocks. Audio tools use CLIProxyAPI's Realtime WebSocket route. A direct harness adapter would use the independent service's own tool contract and credentials, then expose its tools through the same client-facing MCP endpoint. [Provider configuration and extension workflow](providers.md)

## Credentials and files

| Credential | Where it is used |
| --- | --- |
| Provider login or API key | CLIProxyAPI stores upstream authorization in its private configuration or OAuth state. |
| Model client key | CLIProxyAPI checks it on model requests. `npm run init` creates `.state/model.key` when it manages the local CLIProxyAPI configuration. |
| Capability client key | The Capability Proxy checks it on `/mcp`. The default file is `.state/gateway.key`. |
| Capability upstream key | The Capability Proxy presents a CLIProxyAPI client key when it calls upstream. The default is the model key file. An operator can configure a separate file. |

The DSH MCP file adapter runs on the DSH machine. It reads inputs from `gateway-tools/` inside the configured workspace and sends their bytes through MCP. It saves generated PNG and WAV results in that directory. Direct HTTP MCP clients send and receive the media described by the tool schemas.

An authorized paid agent account can supply an individual tool to a workflow whose conversation uses another provider. Capability access depends on the account, the selected model and the CLIProxyAPI route. Configuration selects which tools to advertise. Model discovery and MCP discovery can be checked separately, then an actual tool call checks the upstream route. [Deployment and checks](deployment.md)

Generated keys, OAuth files, runtime configuration, and DSH profiles and workspaces belong under the local state directory by default. The repository allowlist includes source, documentation, and example configuration. Keep deployment overrides and tool outputs in runtime state or another private directory.
