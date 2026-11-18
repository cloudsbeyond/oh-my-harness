# oh-my-harness

[简体中文](README.zh.md)

**Integrations and adapters for harnesses: reuse authorized capabilities and versioned Skills while the host keeps orchestration, sessions and permissions.**

Model APIs, paid Agent capabilities and Skill assets each meet different host interfaces. oh-my-harness maintains those adapters so every harness does not need its own execution wrappers and drifting source copies. DSH is the primary integration; other harnesses can use MCP, core APIs or supported discovery adapters.

![Harness-owned orchestration connects to independent capabilities, model-native semantics and Skill discovery.](docs/architecture.png)

[Architecture and responsibilities](docs/architecture.md) · [Hosted HTTPS deployment](docs/deployment.md)

## Choose an integration

| Need | Entry point |
| --- | --- |
| Call search, image, document, video or speech operations independently | [MCP](#start-with-dsh-through-mcp) or [native DSH bundle](extensions/dsh-capabilities/README.md) using the same core code |
| Preserve search/image events and replay inside a GPT conversation | [DSH Codex model-native adapter](extensions/dsh-native-codex/README.md) |
| Share reviewed, versioned Skills across local agents | [Skill Source Manager](extensions/skill-source-management/README.md), with Codex/Claude Code adapters; lifecycle writes require macOS and Python 3.11+ |

Use these independently. Skills remain host-discovered assets; model-native work stays in the main request and is not executed again as a tool. Provider access and operation support must be verified for the authorized account and route.

## Existing DSH installation: native capabilities

For **DSH 0.2.2-rc.3**, run `npm ci`, install this local repository root through Plugin Manager, then configure [Host credential references and operation defaults](extensions/dsh-capabilities/README.md). Existing compatible APIs can be used directly; MCP and CLIProxyAPI are optional.

A Kimi conversation can use a separately configured Codex provider for search or images. Installing this capability bundle does not migrate the main-model route. [Host integration](docs/dsh-integration.md) · [Verification and UI limits](docs/verification/dsh-0.2.2-rc.3.md)

## Start with DSH through MCP

Install Node.js 24+ and the [CLIProxyAPI v8.0.51 executable](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51) on PATH as `cli-proxy-api`. This example reuses accounts authorized in CLIProxyAPI, including paid Agent subscriptions, and launches a separate DSH Web profile.

```sh
npm ci
npm run init
npm run proxy -- -codex-device-login
npm run proxy -- -kimi-login
```

For one account, initialize with `--provider codex` or `--provider kimi` and run only its login command. Start `npm run proxy` and `npm start` in separate terminals, then:

```sh
npm run doctor -- --models
npm run doctor
npm run dsh
```

Try `mcp__gateway__web_search` with a question requiring sources. Match model IDs/limits in `.state/config.json` to the upstream and verify an actual result. Model API and MCP use separate keys; tool-only clients need only MCP. [Connect other clients or an existing model service](docs/deployment.md)

## Extend and verify

Follow the [extension workflow](docs/providers.md#extension-workflow): identify the host owner, preserve source identity, adapt the missing boundary and verify discovery, execution and delivery separately.

```sh
npm test
npm run test:skills
npm run verify:package
```

[Core contracts](docs/capabilities.md) · [Skill design](docs/skill-source-management.md) · [Version-scoped acceptance](docs/verification/dsh-0.2.2-rc.3.md). Credentials, instance configuration, personal assets and runtime state stay outside public source. [MIT License](LICENSE)
