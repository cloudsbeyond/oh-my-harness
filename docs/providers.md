# Providers and harness extension workflow

Choose the integration boundary before editing configuration. There are two existing provider configuration formats: the stock MCP server's shared-upstream catalog and the DSH native bundle's per-provider settings. Both feed Capability Core; neither configures Skill discovery or the main-model native adapter.

## Stock MCP catalog

The [default config](../config/default.json) connects declared model IDs and capability flags to one protocol-compatible upstream. CLIProxyAPI is the included setup; another upstream must implement each enabled request. Model discovery supplies IDs, not proof that the account supports search, media or every advertised modality.

1. Configure and authenticate the upstream; inspect `/v1/models` and test the intended operation.
2. Add a `providers` entry using `responses`, `chat` or `messages`, declared models, capacities and capability flags. The stock catalog requires globally unique model IDs/aliases; use upstream aliases if needed.
3. Set defaults by capability (`search`, `vision`, `images`, etc.). `text` also makes the provider available to the example DSH Web launcher. `defaults.text: kimi` and `defaults.search: codex` illustrates separate reasoning and search choices.
4. Restart this Capability Proxy when its config changes. Relaunch only the generated DSH profile if its model settings changed; no blanket restart of other installations is required.

`npm run init` writes `.state/config.json`; `OH_MY_HARNESS_CONFIG` selects a complete replacement config. [Multi-provider example](../config/providers.example.json) contains illustrative IDs and limits, not an account capability promise. Keep upstream authorization in CLIProxyAPI or the configured service, and client keys in private runtime state. [Deployment](deployment.md)

| Catalog flag | MCP tools | Core operations |
| --- | --- | --- |
| `search` | `web_search` | `web.search` |
| `vision` | `inspect_image` | `image.inspect` |
| `documents` | `inspect_document` | `document.inspect` |
| `video` | `inspect_video` | `video.inspect` |
| `images` | `generate_image`, `edit_image` | `image.generate`, `image.edit` |
| `audio` | `synthesize_speech`, `transcribe_audio`, `ask_audio` | `speech.synthesize`, `speech.transcribe`, `audio.inspect` |

MCP accepts Base64 media; the stdio adapter exposes file arguments inside its configured artifact directory. [Schemas](../src/tools.mjs) and [core contracts/limits](capabilities.md#operations) define the supported inputs. `list_providers` reports configuration, not tested upstream health. Search result sources are checked against native actions/results; model-assisted URL reading does not replace exact HTTP fetching.

`modelTools: true` optionally retains existing stateless MCP model tools: `list_models`, `get_model`, `generate_text`, `generate_structured`, and `count_input_tokens`. Model-tool aliases and token-source configuration are explicit compatibility features. They do not change capability routing or replace the separate conversation model API.

## Native host providers

The [DSH native bundle](../extensions/dsh-capabilities/README.md) uses operation defaults such as `image.inspect` and provider-local model IDs. Each provider can have its own endpoint and Host credential reference. Equal model IDs across providers are allowed, but an ambiguous bare model requires an explicit provider. These are native/core semantics; they do not relax the legacy MCP catalog's global alias rule.

A trusted Host plugin can register a provider with `omhCapabilities.register`, and a standalone consumer can use `CapabilityRuntime.register`. No model is required for a local deterministic provider. The core contract is available through the package's `./capabilities` export. Credential resolution, filesystem admission and UI delivery stay in the caller's adapter. [Independent provider example](capabilities.md#independent-providers)

## Extension workflow

There are two independent sources of change: what a provider executes and how a harness admits, invokes and presents it. If the same operation already exists, changing its source should not require editing every host UI or MCP schema. If only the host changes, the provider driver should remain reusable. Main-model replay and Skill discovery need their own contracts because they carry different state and authority.

Start by identifying that boundary and its existing owner. Retain source identity, adapt the missing interface, define failure/exit behavior, then verify each layer. The table below turns that reasoning into implementation choices.

| New requirement | First implementation choice | Evidence needed |
| --- | --- | --- |
| Another endpoint supporting an existing operation/protocol | Configuration, not new tool code | Actual authorized request and expected output |
| A new provider or independent harness for an existing operation | Driver implementing `execute(operation, input, options)` and registration | Sanitized fixtures, cancellation, result validation and source identity |
| A new atomic operation | Define contract in `src/capabilities/contracts.mjs`, then driver and affected delivery mappings | Inputs/limits, typed result, error semantics, MCP/native delivery |
| An operation exposed in another harness | Host adapter using that host's credentials, files and lifecycle | Host discovery, authorized invocation and usable result delivery |
| Search/image events within the main model stream | Model-native extension | SSE ordering, citations/media, function calls, second-turn replay and safe interruption |
| Versioned Skills in another client | Discovery/lifecycle adapter in Skill Source Manager | Reviewed source, guarded update/rollback, new-process discovery and separate invocation checks |

For a new operation, update the core contract and test it first; put protocol work in `src/capabilities/`, MCP encoding in `src/tools.mjs`, and host projection in the corresponding extension. Do not put provider execution back inside MCP callbacks. Preserve public tool schemas unless a separately reviewed contract change is required.

An independent harness adapter must map a bounded operation to that service's real HTTP/MCP contract and credential owner. The core registration interface exists; the stock server does not currently load arbitrary external adapter modules from JSON. Do not claim that a sample registration or config entry provides a ready-made remote connector.

Keep conversation planning, memory, permissions and final judgment with the harness. Reuse existing host search, file, Office and speech services before adding UI or another framework. A new feature belongs here when it closes a concrete harness integration gap with an owned adapter and testable boundary—not merely because it is Agent-related.

## Verification and enablement

Use local fixtures for the core/driver, then test affected MCP/host mappings. Verify the actual distribution with `npm run verify:package`; run `npm test` and relevant module suites. [DSH method and baseline tests](dsh-integration.md) · [Skill asset verification](skill-source-management.md#acceptance-and-implementation-sequence)

Keep evidence separate: source/config accepted → host or tool discovered → authorized operation executed → result delivered → repeat/update/rollback behavior verified. A successful fixture or `/models` response does not prove a paid upstream or rendered UI works. Enable only the tested configuration, retain a rollback path, and report any blocked acceptance explicitly.
