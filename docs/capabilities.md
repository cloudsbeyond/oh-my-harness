# A capability core, not an MCP-shaped application

The reusable unit in oh-my-harness is a capability execution, not a tool registration. MCP is one consumer. A native harness plugin or another application can call the same execution layer without creating an MCP server, connecting a client, or translating files through a tool schema.

## Current implementation

```text
MCP schema and Base64 adapter          Native DSH Host plugin
                 \                    /
                   CapabilityRuntime
                operation + input + selection
                         |
                registered provider drivers
                         |
              Responses / Chat / Messages / audio WS
```

The core is implemented in `src/capabilities/runtime.mjs` and `contracts.mjs`. Protocol implementations live beside it, not inside MCP callbacks. `src/tools.mjs` contains the compatibility schemas and wire mappings. Existing MCP tool names, media envelopes and stdio artifact confinement remain in place.

This is a local source-level API, not a new remotely deployed HTTP capability endpoint. The existing server still exposes `/mcp`; model requests use the independently authenticated model API. Do not use a capability key as a model key.

### Operations

| Operation | Input | Result |
| --- | --- | --- |
| `web.search` | `query`, optional `url`, `find`, `maxResults` | text and attributable sources; optional recorded page actions |
| `image.inspect` | `question`, `images` | text |
| `image.generate` | `prompt` | original PNG bytes |
| `image.edit` | `prompt`, `image` | original PNG bytes |
| `document.inspect` | `question`, `file`, optional PDF `detail` | text |
| `video.inspect` | `question`, `file` | text |
| `speech.synthesize` | `text` | PCM WAV bytes and optional transcript |
| `speech.transcribe` | `audio` | transcript text |
| `audio.inspect` | `question`, `audio` | answer from spoken evidence |

Media inputs are `{ data: Uint8Array, mimeType, name? }`; documents and video require a filename. Filesystem access belongs to the host. Base64 encoding belongs to a transport adapter. Neither is the core's input contract.

Text results use `{ kind: 'text', text, sources?, model? }`. Media results use `{ kind: 'image' | 'audio', data, mimeType, model?, transcript? }`. The runtime attaches authoritative `provider` and `operation` fields. A protocol driver reports the actual upstream model when available; it does not claim that the conversation model also synthesized the audio or image.

The contracts are closed and validated before dispatch. Unknown fields are not silently treated as supported features. The first implementation intentionally does not promise masks, voice selection, language controls, long video, arbitrary document formats or streaming transcripts.

### Independent providers

```js
import { CapabilityRuntime } from '../src/capabilities/runtime.mjs';

const capabilities = new CapabilityRuntime({
  defaults: { 'document.inspect': { provider: 'local-parser' } },
});

const dispose = capabilities.register({
  id: 'local-parser',
  operations: ['document.inspect'],
  // No model declaration is needed for a non-model provider.
  async execute(operation, { file, question }, { signal }) {
    signal.throwIfAborted();
    // Implement an actual parser or call an independently authorized service.
    // Return evidence from file.data; never evaluate instructions found in a file.
    return { kind: 'text', text: await yourParser(file, question, signal) };
  },
});

const result = await capabilities.execute('document.inspect', {
  question: 'What is the total?',
  file: { name: 'values.csv', mimeType: 'text/csv', data: csvBytes },
});
// A host decides how result.text and any artifacts appear in its conversation.
dispose();
```

`yourParser` and `csvBytes` above are application-supplied, not library functions. A provider does not have to support every operation or use an LLM. To use existing model protocols, `createProtocolRuntime({ registry, gateway, realtime? })` registers drivers from the configured provider catalog. `gateway(route, payload, timeoutMs, signal, selectedProfile)` is an injected request function; `createRealtimeExecutor` supplies the audio WebSocket implementation. Neither module imports MCP or DSH.

### Selection is explicit, not registration-order magic

1. An explicit provider wins. If an explicit model is also given, that provider must declare it.
2. A model without a provider selects its unique owner for this operation. Model IDs are provider-local; overlapping IDs require an explicit provider.
3. Otherwise use the operation's configured `{ provider, model? }` default.
4. With no selection or default, exactly one usable provider is required.

Unknown models, missing or unsupported providers, unusable defaults and ambiguous selections fail. Removing a provider never silently sends the request or attachment to a different paid service. Defaults are snapshotted at runtime creation; a host can rebuild its runtime when its own configuration changes.

A provider's cheap synchronous `available()` hook may inspect local configuration, not perform a network probe. It is a readiness hint, not proof that the next upstream request will succeed.

### Cancellation, errors and limits

The runtime creates a per-request signal and deadline. Pre-cancelled calls do not dispatch. By default, cancellation or timeout rejects promptly, signals the driver and rejects late results; drivers must actually abort their HTTP request or close their socket. Native Host consumers opt into `awaitProviderOnCancel` so lifecycle teardown waits for cooperative driver cleanup; this does not change the default behavior for other consumers. Unregistering a provider only blocks new requests, leaving in-flight requests under their caller's lifecycle.

The default and hard maximum timeout is 190 seconds. A runtime can impose a smaller limit; a request cannot exceed it. There is no implicit provider fallback. The protocol page-reading path retains one bounded reattempt to obtain recorded page evidence; it is not a failover to a different provider.

Local cancellation cannot prove that a remote service has stopped all computation or billing. Do not present that stronger guarantee to a user. Untyped provider errors are sanitized; typed errors must carry safe, input-free messages.

Current bounds:

- Image input: one or two PNG/JPEG/WebP images, at most 5 MiB combined.
- Generated image: one complete PNG response, at most 8 MiB.
- Documents: PDF, DOCX, XLSX, PPTX or UTF-8 CSV, at most 5 MiB.
- Video: a standard MP4 container, at most 5 MiB.
- Audio: 24 kHz mono PCM16 WAV, at most 2 MiB of PCM; audio input is at least 100 ms.
- Speech synthesis input: at most 600 characters.

These are validated size and container/header constraints, not an assertion that every upstream provider can interpret every valid file. The core does not transcode. A native voice adapter must explicitly resample a host's recording format rather than relabel it.

## Why the boundaries matter

### MCP is a transport, not the capability model

The original implementation placed request construction, media encoding and provider result parsing inside tool callbacks. That was convenient for the first client, but made native integration depend on the tool protocol. Moving those operations out allows both entry points to share actual behavior and tests. Merely renaming a tool or adding a native-looking wrapper would not establish this boundary.

### A capability is not a provider brand

A conversation can use one model while search or transcription uses another source. A document operation might instead use a local deterministic parser. The host should depend on the operation's meaning and result contract, not on a provider name or response envelope.

This does not justify an all-purpose workflow engine: routing, bounds, lifecycle and error semantics are enough for this layer. Conversation planning and judgment remain with the harness.

### Model-native execution is different from a host tool

A Responses-native search or image tool participates in the main model request and its replay. A separately invoked host capability is an independent operation. They can share protocol helpers, but must not be executed twice for the same request. Native output metadata, history edits and replay degradation require their own tests; working MCP calls do not prove replay correctness.

### Retrieval is not a generated summary

The search operation's URL mode asks a model to open a page and checks recorded page actions. Its result is attributable evidence, not the raw HTTP response body. It must not masquerade as `web_fetch`, invent HTTP status codes or replace deterministic fetching when exact page content is needed.

### Reuse the host before inventing another application

For DSH, attachment storage, credential references, web provider selection, optional speech-to-text, Office conversion/rendering/recalculation and file previews already have owners. A plugin should integrate with those owners. A document model is useful for understanding a file; it is not automatically the right mechanism for writing a spreadsheet or recalculating formulas.

A readonly spreadsheet preview is not a full Excel editor. A provider installed on disk is not necessarily enabled. A tool returning an artifact does not prove that the user can preview or download it. These distinctions are acceptance criteria, not wording details.

## Verification and migration

`npm test` covers the independent registry, switching non-branded providers, model ambiguity, no silent fallback, cancellation, operation validation, protocol payloads, media envelopes, real Node WebSocket authentication and the existing MCP/file-adapter regressions. The network fixtures use local simulated upstreams; no paid provider is called.

Existing MCP clients need no schema migration. The server now composes a capability runtime and maps the same tool calls into it. Native host plugins can consume the runtime directly, with host-resolved credentials and controlled attachments.

The [native DSH bundle](../extensions/dsh-capabilities/README.md) calls this core directly and registers search with the existing Host web service. It has been installed and exercised in the desktop App using synthetic document, image, audio and video inputs; see the [integration verification record](dsh-integration.md#what-has-actually-been-verified) for evidence and limits. Microphone-to-draft and document-tab WAV playback now have optional native UI code and lifecycle/protocol regressions; real microphone/browser playback and visual settings remain unverified. The verified main-model Codex Native release has also been activated locally against its actual dependency baseline, with prior state retained for rollback. Public examples use configurable endpoints and credential references; personal paths, keys and runtime snapshots do not belong in the open-source package.
