# Capability execution contract

`CapabilityRuntime` executes an independent operation against a selected provider. It is an in-process API shared by MCP and native host adapters; [architecture and ownership](architecture.md) describes their placement.

## Current implementation

`src/capabilities/runtime.mjs` and `contracts.mjs` own selection, validation and lifecycle. Protocol drivers live beside them; `src/tools.mjs` owns MCP schemas and encoding. Host adapters own filesystem access, credentials and result delivery.

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

Delivery adapters retain their existing host/wire contracts. Native tool values preserve provider/operation identity, but their rendered text does not always display it. DSH's `ctx.web` search projection returns content and sources without provider/model fields; legacy MCP image/audio envelopes also omit that execution identity. Use the core result or the selected route/configuration when tracing execution; a visible result or citation alone does not prove which provider ran it. Adding a uniform identity field to all public result schemas requires separate compatibility review.

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

### Search evidence

`web.search` URL mode requires recorded page actions and returns attributable evidence, not a raw HTTP body. Use the host's deterministic fetch service when exact response content is required.

## Verification and migration

`npm test` covers operation contracts, provider selection, cancellation, protocol payloads, media results and MCP/file-adapter compatibility using local fixtures. Existing MCP schemas remain unchanged. Model-native replay, host attachment delivery and Skill lifecycle have separate integration boundaries and checks.

[Extension workflow](providers.md#extension-workflow) · [DSH host integration](dsh-integration.md) · [Version-scoped evidence](verification/dsh-0.2.2-rc.3.md)
