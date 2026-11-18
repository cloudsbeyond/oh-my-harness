# Harness integration architecture

This reference maps the [project rationale and integration model](../README.md#how-the-integrations-fit-together) to code, deployment and credential owners. The README and linked methodology documents explain the design decisions.

[Architecture diagram](architecture.png) · [Machine-readable responsibilities and deployments](architecture.json)

## Three integration boundaries

| Integration | Implementation | Responsibility |
| --- | --- | --- |
| Independent capability execution | `src/capabilities/`, MCP adapter, `extensions/dsh-capabilities/` | Execute one operation against an explicitly selected provider; deliver typed evidence or original media |
| Main-model native semantics | `extensions/dsh-native-codex/` and shared release utilities | Adapt the primary model stream, citations, images, replay and interruption without executing provider-native work twice |
| Skill assets and host discovery | `extensions/skill-source-management/` | Maintain reviewed sources, version evidence, publication, update, rollback and client discovery bindings |

These modules share integration principles, not a compulsory runtime. The Skill manager is an optional local command, not a service on every request. The model-native adapter is not another transport into Capability Core. A host may use any of the three independently.

## Capability execution and delivery

MCP maps schemas and Base64 envelopes to the core. The native DSH adapter maps admitted host files and credential references to the same operations, then projects results into attachments and files. Each composition creates its own runtime; sharing code does not require a common remote server. [Operation contract](capabilities.md)

Provider drivers implement an operation rather than taking ownership of a conversation. The built-in protocol driver handles Responses, Chat, Messages and injected Realtime execution. A host plugin or application may register a local parser or an independently authorized service directly. The registry interface is implemented; a ready-to-run remote independent-harness MCP/HTTP adapter is still an extension task, not a configurable feature shipped today.

The stock MCP server uses a single configured model-protocol upstream and key. Native DSH configuration supports separately configured provider endpoints and Host credentials. Do not interchange their configuration schemas. [Provider settings and extension workflow](providers.md)

## Model Proxy and Capability Proxy

| Role | Example | Client contract |
| --- | --- | --- |
| Model Proxy | External CLIProxyAPI, or an existing compatible model service | Model inference/catalog APIs; `/v1` in the hosted example |
| Capability Proxy | oh-my-harness MCP adapter composed with Capability Core | Streamable HTTP `/mcp` with a distinct client key |

The optional `npm run proxy` command launches the external CLIProxyAPI executable. Model and capability endpoints have independent configuration and keys; the [README](../README.md#reuse-capabilities-without-fixing-the-conversation-provider) explains how their roles can be combined.

## Deployment and credentials

For hosted access, Caddy or NGINX terminates HTTPS on domain names and routes `/v1` and `/mcp` to separate loopback backends. Either one or two hostnames can be used. A colocated client may use loopback directly. DSH and Gateway can live on different hosts; neither depends on a client SSH tunnel. [Deployment instructions](deployment.md)

| Credential | Owner and use |
| --- | --- |
| Provider account/API authorization | The upstream service or CLIProxyAPI's private OAuth/config state |
| Model client key | Model API authentication |
| Capability client key | Authentication to `/mcp`; never reused as the model key |
| Capability upstream credential | The selected provider; stock MCP uses a key file, native DSH uses Host credential references |
| Independent-harness credential | Application-supplied adapter and that external service |

The MCP stdio file adapter runs beside its client and confines files to its artifact directory. Native DSH uses its attachment and filesystem services, enforcing admission before upload and keeping output delivery with the host. These are distinct file policies, not interchangeable path settings.

## Skill asset integration

`extensions/skill-source-management/` is an optional local CLI, not a DSH runtime plugin. Source, lifecycle and discovery contracts are defined in the [Skill methodology](skill-source-management.md); supported clients, commands and layouts are maintained in its [module README](../extensions/skill-source-management/README.md).

## Source and instance ownership

Public source contains reusable code, examples, fixtures and evidence of supported boundaries. Private instance configuration owns endpoints, host paths, model choices, credentials, accepted personal assets, receipts, runtime state and task outputs. Installation examples and tests use isolated state; an open-source reference module does not silently replace an existing host manager.

Architecture JSON describes responsibilities and example placements, not executable deployment configuration. Its `schemaVersion` versions this descriptive structure independently of package or upstream versions. The picture illustrates that model; integration status and supported limits are authoritative in text and tests.
