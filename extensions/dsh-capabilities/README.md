# Native DSH provider capabilities

The root oh-my-harness package is also an optional DSH bundle. Its `oh-my-harness/dsh` Host plugin calls the independent capability core directly; native tools do not start an MCP client or translate through MCP envelopes.

This initial bundle targets the tested DSH **0.2.2-rc.3** interface. Install the local repository root through Plugin Manager, not this subdirectory. Host imports are optional peers: standalone core/MCP use does not require DSH packages, while a linked plugin gets them through DSH's host resolver. No global resolver hook or personal dependency symlink is needed.

## Configure before use

The default configuration is dormant (`providers: {}`). Open this plugin's configuration in Plugins, add providers and choose defaults per operation. Credentials are **Host credential references**, not inline bearer values or key-file paths.

```json
{
  "providers": {
    "example": {
      "protocol": "responses",
      "baseURL": "https://model-proxy.example.com/v1",
      "credential": "MY_MODEL_API_KEY",
      "models": ["your-model"],
      "operations": ["document.inspect", "image.inspect"]
    }
  },
  "defaults": {
    "document.inspect": { "provider": "example", "model": "your-model" },
    "image.inspect": { "provider": "example" }
  },
  "maxConcurrentTasks": 4
}
```

Each provider may declare a different subset of operations. Equal model IDs across providers are allowed; select the provider explicitly when a bare model name is ambiguous. A missing/disabled default fails clearly rather than uploading the input to a fallback provider. Configuration changes are applied through DSH's normal config lifecycle, not by plugin code rewriting profile YAML.

Additional protocol fields:

- `web.search`: declare `search: "responses"` or `"messages"`. DSH's **existing** web provider menu can select `oh-my-harness`; the bundle does not silently change that choice. Deterministic `web_fetch` remains separately configured.
- `image.generate` / `image.edit`: declare `imageModel`. One PNG is returned; masks are not part of this contract.
- `speech.synthesize` / `audio.inspect`: declare `realtimeModel`.
- `speech.transcribe`: declare both `realtimeModel` and `transcriptionModel`.
- `document.inspect` needs a Responses provider; `video.inspect` needs a Chat provider. Image understanding supports Responses, Chat and Messages.
- Optional `enabled: false` pauses a provider. `name` is a display label. `reasoningEffort` applies only where the protocol supports it.

`capability_providers` reports configured operations, bindings and local credential readiness without returning endpoints or key references/values. Readiness is configuration evidence, not proof that upstream authentication will succeed.

## Native tools

| Tool | Purpose |
| --- | --- |
| `native_image_inspect` | Understand one/two PNG, JPEG or WebP inputs, up to 5 MiB combined |
| `native_image_generate` | Produce one original PNG plus a normalized image attachment |
| `native_image_edit` | Edit an admitted image; preserve original PNG output |
| `native_document_inspect` | Understand PDF, DOCX, XLSX, PPTX or UTF-8 CSV, up to 5 MiB |
| `native_video_inspect` | Understand a standard MP4, up to 5 MiB |
| `native_speech_synthesize` | Read up to 600 characters into a durable WAV file |
| `native_speech_transcribe` | Transcribe canonical 24 kHz mono PCM16 WAV, 100 ms–2 MiB PCM |
| `native_audio_inspect` | Answer from spoken evidence in that WAV format |
| `capability_providers` | Inspect native providers and operation defaults |

Paid/provider tools are only advertised when a registered provider declares the operation. Search stays on `ctx.web`; there is no duplicate search tool. Only invoke provider work for the user's requested purpose. Selected file content/text may leave the Host for the configured provider.

For deterministic document/spreadsheet creation, edits, formulas, conversion, rendering or recalculation, reuse DSH's existing Office skills, bundled libraries and Office kit. A document-understanding model is not a replacement spreadsheet editor.

## File admission and artifacts

Inputs can be workspace paths or paths already exposed for an authenticated user upload. No manual copy into a Gateway artifact folder is required. The bridge checks canonical provider identities before a bounded read, then checks replacement/version changes before dispatch. The policy workspace root is authoritative; changing the working directory does not expand cloud-upload access.

The examined filesystem read API does not itself enforce session/workspace admission. This bridge adds it. Arbitrary SHA references, paths quoted in text, unrelated tool output and other sessions do not authorize uploads. Own generated artifacts are remembered per session for same-turn chaining. After restart they can be reconstructed only from this plugin's real tool-call/result provenance; if compaction removes that evidence, reattach the file.

Image results store an exact original PNG and a normalized image reference separately. WAV results use a canonical generic file reference. Canonical tool values are JSON/ref records, never Base64 media envelopes or raw byte arrays. Saving is not presentation: **use the existing `present` tool to create a delivery card**. Paths are mapped through the execution-world filesystem; no private HTTP download route is invented.

Disabling the bundle removes its tools, web provider and shared service; saved artifacts remain. Active calls are cancelled and cooperative driver cleanup is awaited. There is a bounded number of active tasks and no hidden queue that later performs paid work.

## Provider extension point

Another trusted Host plugin may inject `omhCapabilities` and register a provider with the same core operation contract. It owns the returned disposer:

```js
export const inject = ['omhCapabilities'];
export function apply(ctx) {
  ctx.effect(() => ctx.omhCapabilities.register({
    id: 'local-parser',
    operations: ['document.inspect'],
    async execute(_operation, { file, question }, { signal }) {
      signal.throwIfAborted();
      return { kind: 'text', text: await yourLocalParser(file.data, question, signal) };
    },
  }));
}
```

`yourLocalParser` is application-supplied. Providers must honor cancellation and settle after their owned cleanup; native tools intentionally await that settlement. The independent core's default fast-return cancellation mode remains available to other consumers.

## Verification and current limits

Node fixtures cover file admission/provenance, provider switching, cancellation, original bytes, uploads and same-session image/audio follow-ups. Separate tests run the actual App `defineTool`, Host Config and canonical output validator; a local HTTP fixture verifies that native definitions reach the model API directly, without MCP.

These fixtures alone do not prove installation or activation. Separate live desktop App acceptance has exercised this bundle's native document, image, video and audio tools, same-session artifact follow-ups, provider switching and existing built-in search; see the [verification record](../../docs/dsh-integration.md#what-has-actually-been-verified). Verify Plugin Manager activation and an actual native call in each installation. Rendered icon/configuration display remains unverified without browser control.

The root bundle includes a bounded WAV player in the **document-preview tab** (not every chat bubble). Install [the optional voice-input bundle](../dsh-voice-input/README.md) separately, after the capability bundle, to reuse the speech registry/controller and add microphone-to-draft transcription. The 16→24 kHz adapter is explicit; recordings are capped at 40 seconds. Do not also activate the official voice bundle's competing registry/controller composition. Generic delivery/system opening and Office previews remain Host-owned. Neither bundle provides full-duplex voice or a full Office editor. Real microphone permissions, actual browser codec playback, and visual settings remain unverified.

See [capability contracts](../../docs/capabilities.md) and [integration decisions](../../docs/dsh-integration.md) for the separation between core execution, model-native replay and the Host experience.
