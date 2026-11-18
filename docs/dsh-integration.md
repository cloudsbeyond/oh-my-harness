# DSH host integration

These integration rules target DSH **0.2.2-rc.3**. The [architecture](architecture.md) defines project responsibilities; the [capability contract](capabilities.md) and [Codex model-native adapter](../extensions/dsh-native-codex/README.md) own their execution semantics.

## Why host adaptation needs its own boundary

A provider returning a result is only half the integration. The host must decide whether input files may leave the session, store outputs as durable attachments, make them available on follow-up turns, and dispose registrations and active work safely. A tool name or thin HTTP wrapper cannot provide those properties by itself.

Independent capabilities and main-model native events reach that host through different paths. The former runs an explicit operation; the latter is already part of the model request and changes citations, ordering and replay. Treating a native event as another executable function can duplicate work, while flattening it into text loses information needed by the next turn. The host adapter therefore reuses existing services without taking over the conversation runtime.

## Reuse the host's services

| Concern | Existing owner | Integration boundary |
| --- | --- | --- |
| Search and HTTP fetching | `ctx.web` registries | Register one search provider; keep exact HTTP fetching separate |
| Credentials and configuration | Host credentials and config editor | Resolve references; do not rewrite user profiles from plugin code |
| Images and files | Attachments/upload and filesystem services | Admit inputs before cloud upload; preserve durable references and original output bytes |
| Office editing, conversion and calculation | Existing skills, libraries and Office kit | Use deterministic document operations; a model inspection or preview is not an editor |
| Microphone input | Optional speech-to-text service and voice input UI | Adapt the actual recording format and respect the existing service owner |
| Result delivery | Present and file-preview paths | Verify that users can open the returned artifact, separately from model-visible output |

Use a small plugin-owned contract only where the host has no suitable extension point. [Native bundle configuration](../extensions/dsh-capabilities/README.md)

## Admit files before upload

A successful filesystem read is not upload authorization. The bridge admits:

- A canonical descendant of the session policy's original workspace root.
- An exact attachment exposed by a real user message in `session.deriveMessages()`, using structured file/image references.
- Its own generated artifact in the same session, supported by tool provenance or its bounded per-session cache.

Resolve identity through the filesystem provider, perform bounded reads, and reject replacements/version changes before dispatch. A changed working directory does not expand the workspace boundary. Paths in untrusted text, arbitrary tool results or another session do not authorize upload. If compaction removes attachment evidence, request reattachment.

## Deliver artifacts through host interfaces

Generated images retain original PNG files and normalized image attachments for follow-up. Audio is a durable file. Saving bytes and producing a model-visible result are separate from showing a usable preview/download control.

The root bundle includes a WAV player in the **document-preview tab**. The [optional voice bundle](../extensions/dsh-voice-input/README.md) separately handles microphone capture, format conversion and guarded draft insertion; it never auto-submits. Its provider, recording limits and activation requirements belong in that module's instructions.

UI code uses the host React and Remote contracts. The root bundle's relative no-op Host entry lets DSH discover its client manifest; a `package/subpath` entry alone is insufficient in this baseline. Keep that loader entry and the reproducible `npm run build:client` output. Reuse an existing speech Remote and avoid competing speech registry/controller owners.

## Own lifecycle and cancellation

Remove registrations when the plugin unloads, cancel in-flight work and await cooperative cleanup. A WebSocket `close()` call starts a handshake; native teardown waits for actual closure. Retire preview Blob URLs on replacement/disposal and reject incomplete or changed files. Local cancellation does not prove that upstream computation or billing stopped.

Treat Cordis Fibers as their actual awaitable/disposable type, and mount a Remote's default contribution rather than its module namespace. Source tests cover these interface boundaries; real browser playback and microphone permissions require separate acceptance.

## Reason about compatibility and execution state

Configuration records intent. Activation, credential resolution, actual dispatch and result delivery are separate states with different owners. A plugin can be declared but unavailable; an environment variable can be absent while the Host credential service correctly resolves its reference. Check the responsible service before replacing a working route.

Dependency identity also matters beyond version labels. Equal DSH adapter bytes can execute with different pi-ai dependencies and request-header dialects. A build input path alone does not control ESM resolution. The native extension verifies the resolved dependency identity and includes it in a reproducible release so a later upgrade fails visibly rather than silently changing replay behavior. Exact locks and build commands belong to the [Codex adapter instructions](../extensions/dsh-native-codex/README.md).

Retry decisions follow execution semantics. A refusal before output differs from interruption after visible text or paid native work: replaying the latter may duplicate effects or charges. Keep those failures distinct, preserve safe diagnostic identifiers, and let the host own its bounded retry policy. Local function dispatch, model-native events and cancellation must be tested together.

## Update a working installation

Compare deployed and versioned source before rebuilding; retain later fixes and private rollback state. Use the [reviewed SDK identity, build instructions and retry rules](../extensions/dsh-native-codex/README.md). A stale fingerprint calls for review, not patching the installed App or installing a global resolver hook. Apply only owned profile changes so unrelated model/provider edits survive.

## What has actually been verified

The [version-scoped record](verification/dsh-0.2.2-rc.3.md) separates fixture results, real Host dispatch and outstanding UI/provider checks. Installation, activation and successful delivery are different observations; check each affected boundary after a change.
