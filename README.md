# oh-my-harness

[简体中文](README.zh.md)

**Integrations and adapters for harnesses: reuse authorized capabilities and versioned Skills while the host keeps orchestration, sessions and permissions.**

## Why this project exists

A harness can already plan tasks and call a model, yet still lack usable search, image generation, document understanding or speech. A paid Agent account may expose those capabilities through its own protocols and execution model. Connecting a text-completion endpoint does not automatically bring its tool events, citations, attachments or file delivery into another harness.

The missing work is integration. Each capability source has different inputs and results; each host has its own credentials, file authority, lifecycle and UI. Reimplementing those joins for every provider and every harness couples the task workflow to one vendor and duplicates the same adaptation work.

Skill reuse presents a related problem at a different stage. Copying a Skill into several agents makes it available initially, but creates multiple editable sources with unclear versions and update history. Sharing the source still requires respecting each host's discovery rules and execution authority.

oh-my-harness addresses these integration boundaries. It lets an existing harness reuse authorized external capabilities and reviewed Skill assets while retaining responsibility for planning, sessions and judgment. DSH is the primary integration and acceptance host; MCP, the independent core API and supported discovery adapters also serve other harnesses.

## How the integrations fit together

![Harness-owned orchestration connects to independent capabilities, model-native semantics and Skill discovery.](docs/architecture.png)

| Integration | Problem it solves | Implementation |
| --- | --- | --- |
| Independent capabilities | Call a bounded operation without tying it to the conversation model | Capability Core, provider drivers, MCP and native host adapters |
| Model-native semantics | Preserve search/image events inside a main-model response and its later replay | DSH Codex model-native adapter |
| Skill assets and discovery | Maintain one accepted source with version evidence, guarded updates and host-specific discovery | Optional Skill Source Manager |

These boundaries follow execution semantics. A standalone image tool produces an independent result; a native image event already executed inside the model stream must be preserved, not executed again. A Skill is an instruction/resource asset whose use is decided by its host, not another callable provider operation. Forcing all three through MCP or one service would erase those differences.

MCP and native plugins reuse the same capability core code in their own deployments. They do not require a shared remote Runtime. The Skill manager runs independently of requests. [Component placement and credentials](docs/architecture.md)

## Reuse capabilities without fixing the conversation provider

A DSH conversation can use Kimi for reasoning and a configured Codex provider for search or images. A document operation may instead use an application-supplied local parser. The harness selects the operation and evaluates its result; the adapter handles the source-specific protocol and output mapping.

The hosted example separates two roles:

| Role | Responsibility | Client interface |
| --- | --- | --- |
| Model Proxy | Model inference/catalog access and upstream routing | `/v1` in the CLIProxyAPI example |
| Capability Proxy | Expose independent operations through MCP using the execution core | `/mcp`, with a separate client key |

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is an external model-proxy implementation that can reuse accounts you authorize, including paid Agent subscriptions. It is not the capability core or a requirement for native provider integration. Existing compatible model services can remain in use, and a tool-only client needs only capability access. An independent harness can also be a source through a dedicated adapter; a ready-made connector is not shipped for every service.

Subscription ownership alone does not guarantee a particular operation. Verify the account, model, protocol and actual result. Keep remote access behind HTTPS domain routes; colocated deployments may use loopback. [Deployment options](docs/deployment.md)

## Design method

The project grows by closing concrete harness integration gaps, rather than by adding a new tool name for every provider feature:

1. **Start from the operation and existing owner.** Reuse host credentials, files, search, speech and previews. The adapter should supply what the host lacks, without becoming another planner or permission system.
2. **Choose the boundary before the implementation.** Existing operations usually need configuration or a provider driver; another host needs a delivery/discovery adapter; main-model events need stream and replay handling.
3. **Preserve meaning across the boundary.** Retain attributable sources, original media, declared provider selection and version evidence. Define cancellation, errors and rollback without silently changing the source or repeating completed work.
4. **Verify the user-visible outcome in stages.** Configuration, discovery, execution and delivery are different observations. A successful fixture or an advertised tool does not prove real host behavior.

[Capability contracts and rationale](docs/capabilities.md) · [Extension decisions](docs/providers.md#extension-workflow) · [DSH integration reasoning](docs/dsh-integration.md) · [Skill design](docs/skill-source-management.md)

## Existing DSH installation: native capabilities

For **DSH 0.2.2-rc.3**, run `npm ci`, install this local repository root through Plugin Manager, then configure [Host credential references and operation defaults](extensions/dsh-capabilities/README.md). This bundle can call compatible provider APIs directly; it does not require an MCP server or CLIProxyAPI.

The bundle joins the host's search and attachment paths and includes document-tab WAV preview. [Optional voice input](extensions/dsh-voice-input/README.md) handles microphone-to-draft transcription. For search citations, images and replay inside a GPT main-model conversation, install the separate [Codex model-native adapter](extensions/dsh-native-codex/README.md); adding independent capabilities does not migrate that model route.

## Start with DSH through MCP

Install Node.js 24+ and the [CLIProxyAPI v8.0.51 executable](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51) on PATH as `cli-proxy-api`. This example launches an isolated DSH Web profile:

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

Match IDs and limits in `.state/config.json` to your upstream. Ask `mcp__gateway__web_search` a question requiring sources and inspect the actual result. [Endpoints, key files and other clients](docs/deployment.md)

## Skill assets and host discovery

The [Skill Source Manager](extensions/skill-source-management/README.md) preserves origin/version evidence and supports reviewed publication, update, binding and rollback for standalone Skills. It currently provides Codex/Claude Code discovery adapters, with Python 3.11+ and macOS required for lifecycle writes.

Accepted sources and private operation records live outside this checkout. Sharing source does not unify the agents' tools, permissions or model behavior, and the manager does not automatically replace an existing user's installation system. [Design and lifecycle boundaries](docs/skill-source-management.md)

## Verification and source ownership

```sh
npm test
npm run test:skills
npm run verify:package
```

These commands cover isolated core/adapter behavior, Skill lifecycle and actual distribution contents. Native SDK builds, fresh host discovery, paid-provider calls and browser acceptance have separate prerequisites. [Version-scoped evidence and open checks](docs/verification/dsh-0.2.2-rc.3.md) records those distinctions, including playback and microphone acceptance still outstanding.

Public source contains reusable implementation, examples and tests. Real endpoints, credentials, personal Skills, receipts, sessions and task outputs remain private. [MIT License](LICENSE)
