# oh-my-harness

[简体中文](README.zh.md)

A harness that can call a model still needs to integrate each provider's web search, image, document, and speech interfaces. For example, Codex exposes search actions through Responses, while Kimi returns server search results through Messages. Implementing these integrations in every client repeats the routing, request handling, and result parsing.

oh-my-harness packages capabilities from different sources behind a provider-neutral execution core. MCP tools are one compatible entry point; native host plugins can call the same core without MCP. [Capability contracts and design decisions](docs/capabilities.md). In DSH, a conversation can use Kimi for reasoning and call Codex's `web_search` for a lookup with sources. The CLIProxyAPI-backed MCP setup uses accounts you authorize in CLIProxyAPI, including paid agent subscriptions. An independent harness is another upstream source. Connecting it directly requires a dedicated adapter in the Capability Proxy. [Architecture](docs/architecture.md)

![HTTPS ingress routes model and MCP requests separately. The Capability Proxy calls CLIProxyAPI and can be extended with a direct independent harness adapter.](docs/architecture.png)

The solid lines show the CLIProxyAPI/MCP deployment routes. The purple dashed line shows the independent harness extension path.

## Native Desktop DSH bundle

For an existing DSH **0.2.2-rc.3** installation and model API, install the local repository root through Plugin Manager. Configure Host credential references, providers and per-operation defaults in the [native bundle settings](extensions/dsh-capabilities/README.md). Native image, document, video and speech tools call the core directly, without an MCP server or manual file copying. Search registers with DSH's existing web provider menu; HTTP fetching remains separate. The root bundle adds WAV playback in the document-preview tab; the [optional voice bundle](extensions/dsh-voice-input/README.md) transcribes microphone input into the guarded draft without auto-submission. Real microphone permissions and browser playback still need App acceptance; source tests are not visual verification.

The CLIProxyAPI/MCP setup below remains a compatible alternative, not a prerequisite for that native bundle.

## Start with DSH through MCP

Install Node.js 24+ and put the CLIProxyAPI v8.0.51 executable on your PATH as `cli-proxy-api`. [CLIProxyAPI release](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51)

```sh
npm ci
npm run init
npm run proxy -- -codex-device-login
npm run proxy -- -kimi-login
```

For a single account, initialize with `npm run init -- --provider codex` or `--provider kimi` and run the matching login command.

Run `npm run proxy` and `npm start` in separate terminals. They start the Model Proxy and Capability Proxy respectively. In a third terminal, check both endpoints and open DSH.

```sh
npm run doctor -- --models
npm run doctor
npm run dsh
```

`npm run dsh` opens a separate DSH Web profile and workspace. Try `mcp__gateway__web_search` in a session, for example by asking for MCP transport options with sources. If a model ID differs from what your account advertises, update `.state/config.json` using the output from `doctor -- --models`. A tool call verifies that the upstream can perform the capability.

The quickstart uses MCP for tools. For native search citations and generated images in a GPT conversation, install the optional Codex adapter on the DSH host, enable it in the Web profile, and select a GPT model from the provider it registers. [Optional DSH Codex adapter](extensions/dsh-native-codex/README.md)

| Local endpoint | URL | Key file |
| --- | --- | --- |
| Model Proxy | `http://127.0.0.1:8317/v1` | `.state/model.key` |
| Capability Proxy | `http://127.0.0.1:8318/mcp` | `.state/gateway.key` |

## Use another harness or agent

Point compatible model clients at `/v1` and Streamable HTTP MCP clients at `/mcp`. Use each endpoint's key. A tool client needs only the MCP URL and capability key. DSH's local file adapter converts workspace files into MCP inputs. Other clients can pass Base64 as defined by the tool schemas.

For a hosted deployment on your own server, terminate HTTPS at one Caddy or NGINX ingress and route `/v1` and `/mcp` to the two loopback services. The routes can share a hostname or use separate hostnames. [Architecture and credentials](docs/architecture.md) · [Deployment](docs/deployment.md) · [Providers and tools](docs/providers.md)

`npm test` uses a local simulated upstream to check routing, credential separation, MCP tools, and the file adapter.

[DSH integration: code, design decisions and verification](docs/dsh-integration.md) · [Codex Native extension and reproducible builds](extensions/dsh-native-codex/README.md)

[MIT License](LICENSE)
