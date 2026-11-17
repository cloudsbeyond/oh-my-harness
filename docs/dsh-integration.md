# DSH integration: implementation and reasoning

This document collects reusable decisions from integrating oh-my-harness with DSH. The code belongs in the public extension/core; deployment addresses, credential values, personal filesystem layouts and runtime snapshots do not.

The examined host is DSH 0.2.2-rc.3. These are version-specific implementation facts, not promises about every future DSH release.

## Three different integration boundaries

### 1. Stateless capability execution

Search, document understanding, image operations and speech can be independent tasks. Their common concerns are explicit routing, bounded inputs, cancellation and normalized results. They should not depend on a conversation, a tool protocol or a UI component.

The [capability core](capabilities.md) provides this layer. MCP converts schemas and Base64 envelopes at its boundary. A native host plugin can instead supply controlled bytes and receive typed results. A new provider implements the operation contract rather than requiring the tool and UI to know its wire format.

This is not a reason to build a second agent runtime. Planning, conversation state and judgment remain with DSH.

### 2. Model-native work and replay

Responses-native search and image tools execute inside the main model request. They affect output ordering, citations, attachment delivery and the next turn's replay. A separately invoked capability is not equivalent, even if it reaches the same provider API.

The [Codex Native extension](../extensions/dsh-native-codex/README.md) owns this path. It preserves ordinary executable function tools while observing model-native work. It stores bounded source metadata, degrades replay safely when historical anchors change, and persists completed generated images as original files plus normalized image references.

Do not invoke a second image/search operation merely because a native output has appeared. Do not describe native search items as host function calls that DSH must execute again.

### 3. Host-native experience

Native experience means joining the host's actual input, permissions, attachment, preview and delivery paths. Registering a tool with a nicer name is insufficient.

For the examined DSH release:

| Concern | Existing owner to reuse | Boundary to preserve |
| --- | --- | --- |
| Search and deterministic fetching | `ctx.web` provider registries | One host-facing selection entry; model-assisted page reading is not an HTTP fetch body |
| Microphone-to-draft transcription | Optional experimental speech-to-text service and voice input UI | Installed is not enabled; a custom provider must accept/convert the host's actual recording format |
| Images and uploaded files | Attachments/upload services | Durable references, permission-aware access, original bytes where promised |
| Office creation and editing | Office skills and bundled local libraries | Use deterministic file creation/manipulation instead of asking a model to invent a binary file |
| Office conversion/rendering/recalculation | Office kit | A readonly preview is not a full editor or spreadsheet calculation engine |
| Artifact handoff | Existing present/file-preview paths | A model-visible result does not prove user-visible preview/download works |
| Provider authentication and configuration | Credentials and config editor | Store references, not secrets; do not rewrite the user's profile from plugin code |

DSH does not thereby have a universal image/audio/document provider service. Where a native extension point is absent, add a small plugin-owned contract with typed results. Do not impose a universal media framework over services that already have clear owners.

## Lessons from migrating a working integration into maintainable source

### A configuration entry is evidence of intent, not execution

A plugin can be declared yet pending or unavailable. A session's allowed-provider list can omit a valid host route. An environment variable can be absent while the host's credential service correctly resolves its reference.

Distinguish composition, activation, credential readiness, actual dispatch and end-to-end delivery. Check the right owner for each fact. Do not reinstall or replace a working route just because one unrelated inspection surface lacks it.

### Recover deployed improvements before rebuilding

A deployed plugin can contain later fixes than the public checkout. Blindly following the older build instructions may discard working transport safety or fail on stale patch anchors.

The recovered source includes client/server request identifiers, safe transport diagnostics and retry classification. Its generator reproduces the reviewed generated adapter byte-for-byte. The current patch preserves newer header-preparation and replay-digest parameters instead of matching only a familiar nearby function name.

An upstream fingerprint or unique-anchor mismatch is a review gate, not a reason to patch the installed application in place.

### A source anchor is not a module-resolution policy

Setting `DSH_NODE_MODULES` tells a build where to read input. It does not automatically make imports in an out-of-tree plugin use that dependency tree. A directory symlink can also outlive the installation it once matched.

The build/test resolver is explicit and local to its launched process. It retains ESM import conditions; using `require.resolve` on every package fails for import-only exports such as the examined pi-ai package. The runtime plugin does not install a global resolver hook.

For an App archive, use the ASAR-aware runtime. An ordinary Node process cannot inspect the archive as normal directories. Dependency input, executing runtime and actual ESM resolution must be checked together.

### Equal adapter hashes do not mean equal environments

The examined App and external installations have identical DSH core adapter bytes but pi-ai versions 1.3.0 and 1.5.2. Both were tested independently; they are not treated as one artifact by assumption.

The build records five host-package identities and fingerprints. The release includes that identity in its content address, and activation rejects a different fingerprint before taking ownership of a route. The record is explicit about its scope: manifest and entry-file hashes are not a complete transitive hermetic environment lock.

### Retrying is an execution-semantic decision

A connection failure before output can be different from interruption after visible text or native paid work. Replaying the latter may duplicate work or charges. Session affinity is also not the same thing as the request identifier needed for diagnosis.

The Native transport wrapper marks unsafe interrupted attempts separately and does not relabel cancellation as a retryable network error. It carries safe codes and identifiers, not raw exception text. Cancellation still cannot promise that the remote service stopped all computation or billing.

### Public code and instance state have different owners

The reusable source should accept endpoints, credential references and artifact/host services as configuration. The instance owns private values and deployment policy. Avoid copying an ad hoc bridge's absolute imports, bearer files or personal paths into a generic plugin.

Keep private build reports and instance plans out of the public file allowlist. Public documentation should preserve the decisions and failure modes, not the original operational transcript.

## File access is not automatically permission to upload

In this DSH version the filesystem sandbox limits mutations; a successful read/stat call is not a workspace-containment or session-attachment ACL. A cloud capability bridge must not infer upload permission merely because `ctx.fs.readBytes` can read a path.

A conservative admission policy is: accept a canonical descendant of the session policy's original workspace root, or an exact attachment already exposed by a real user message in the current model-visible session surface. Use `session.deriveMessages()` and structured image/file references; do not authorize arbitrary content hashes, unrelated tool-result references or paths parsed out of untrusted text. The plugin may also reuse its own generated artifacts in the same session when supported by recorded tool-call/result provenance or its bounded per-session cache. Resolve/compare through the filesystem provider before reading bounded bytes. A mutable working directory is a relative-path base, not permission to expand the workspace boundary. Compaction may remove the evidence for an older attachment; fail closed and request reattachment rather than scanning another session.

Attachment storage is content-addressed storage, not an ACL, and saving a file is not the same as presenting a delivery card. The optional STT service is a transcription seam, not a universal audio service: its canonical 16 kHz recording format differs from the protocol driver's 24 kHz PCM WAV input. Both conversion and the shorter upstream size/duration limit must be explicit. The examined built-in preview set does not provide an inline WAV/MP3 player; generic file delivery/system opening can be reused, while inline playback needs a preview extension.

The native Host bridge enforces the file-admission and artifact constraints above. The optional [voice bundle](../extensions/dsh-voice-input/README.md) now contributes the 16→24 kHz adapter and a microphone-to-draft client. The root bundle contributes a WAV renderer to the **document-preview tab**, not to every chat bubble. Their source-level lifecycle/ABI tests are separate from real microphone and playback acceptance.

### Small UI extensions, not another media framework

Client discovery in this host scans bare package-root or relative/file Loader entries and finds their owning manifest. A `package/subpath` Host entry alone does not activate that package's client. The root bundle keeps its capability entry and adds a relative no-op Host entry for client discovery; voice uses a separately installable package root. The root package includes the optional package's sources so a packed installation retains its tests and add-on.

The voice package owns one speech registry/controller and, when absent, one speech Remote mount; it must not be layered over the official experimental voice bundle's competing composition. Its own settings keys never navigate to or enable the official SenseVoice bundle. The provider id is `oh-my-harness`; replacement of the core `speech.transcribe` default changes dispatch without changing the recorder. Only automatic language detection is advertised. The 40-second bound leaves the resampled audio below the core's 2 MiB PCM limit; elapsed inference timing includes transport. Recording is explicit and transcripts only enter the guarded draft, never auto-submit.

The WAV renderer uses session-addressed workspace-file reads with a single `{ range: { offset, length } }` envelope, native Uint8Array data, at most 2 MiB per window and 8 MiB overall. It requires a complete RIFF/WAVE container, checks versions across reads and with a final metadata stat, and never plays a truncated prefix. Blob URLs belong to one resource/revision and are retired on replacement/disposal. The backend's opaque version token remains the freshness limit; container validation does not prove that a browser supports a particular WAV codec. Local preview permission is not permission to upload that file to a cloud provider.

During integration, preserve both sides of a stale working copy: later canonical source may contain recovery fixes or tests that are not visible in an older shallow checkout. Use a shared commit ancestor and three-way merge, compare existing test bodies/names, and validate both dependency variants. Do not choose an entire side merely because its test count is larger. The Messages search driver's standalone `find` hint remains compatible with the legacy MCP entry; only Responses page-action mode requires `url`.

The generated preview artifact is deterministically built from browser-safe core logic with `npm run build:client`. Keep host React in the module table; do not bundle another React or add a CDN script. The voice Remote default export and Cordis Fiber lifetime must be handled as their actual contracts define: a module namespace is not the Remote contribution, and a Fiber is an awaitable/disposable owner, not a Promise with `.catch()`. Regression probes specifically guard these mistakes. Do not infer functional UI from registration-only mocks.

## What has actually been verified

### Repeatable local tests

- The final root suite passes 131 cases covering the capability core, protocol drivers, native Host file admission/projection/backend/tools, voice input and WAV preview lifecycle/ABI regressions, and existing MCP/file-adapter behavior. The audio-specific suites comprise 33 voice and 13 preview cases, including the capability-settings destination regression; the initial ten adapter cases were relocated into the standalone voice package rather than left as a duplicate provider registration.
- A separate App SDK suite passes five cases using actual `defineTool`, Host Config and canonical output validators. A local HTTP fixture reaches the model API directly without an MCP hop.
- Codex Native's built-source and immutable-release suites each pass 50 cases against the App/ASAR baseline and, separately, the external dependency baseline. Integration preserved the canonical source's four additional SSE/headless retry cases, including real DSH retry/tool-once and persisted retry-exhaustion checks, alongside the working copy's newer image/TIMEOUT/fingerprint regressions. Exact session-affinity assertions follow the reviewed SDK dialect (`session_id` for pi-ai 1.3.0; `session-id` for 1.5.2), while client request IDs remain distinct.
- Native model fixtures exercise real local HTTP/SSE requests: search sources and replay, executable function calls, image declaration, original-image bytes and follow-up editing input, incomplete SSE failure, dependency drift and generated-code drift.
- Five realtime cases also pass under the actual App runtime, including a real local WebSocket authentication handshake. An additional real Cordis Context/Service/Fiber and generated speech contribution probe verifies UI-before-Remote disposal with simulated carrier/slot services; this is not a browser test.
- These automated suites use local fixtures, not paid external providers or private credentials. Passing counts are not a line-coverage measurement.

### Live App acceptance, separately from fixtures

The root native capability bundle was installed and activated in the examined desktop App. With private instance configuration and existing Host credential references, synthetic native calls verified:

| Path | Observed result |
| --- | --- |
| Document understanding | A small CSV with two priced rows produced the expected total of 10 |
| Image generation → understanding → editing | Original PNG output was understood by a different configured provider, then edited into another original PNG through the same native interface |
| Speech synthesis → transcription | A generated WAV was admitted as a same-session artifact and transcribed back to the spoken sentence |
| Audio understanding | A separate question about that WAV was answered from its spoken content |
| Video understanding | A six-second, 60-frame synthetic MP4 was correctly described as red, then green, then blue |
| Existing built-in web search | The selected `oh-my-harness` native `ctx.web` provider returned attributable sources |
| Existing deterministic fetch | The separately configured HTTP fetch path returned an actual HTTP 200 response |
| Cloud file admission | An outside-workspace public source file was rejected with the bridge's admission error |

This is evidence of actual Host dispatch, provider switching and attachment chaining—not merely tool discovery. It is not a browser test of configuration forms, icons, microphone permissions, inline playback or download controls. The first video fixture contained only two frames; probing and rebuilding the fixture, rather than asking the provider to invent a third color, established the final test's input evidence. Private paths, endpoint values and operational records remain outside the public package.

### Cancellation needs observable cleanup

A native plugin's lifetime can end while a provider socket is closing. Calling `close()` starts a WebSocket handshake; it does not prove that the connection has closed. Native cancellation awaits cooperative provider settlement, and the audio executor settles after the close event or an already-CLOSED state. A delayed-close regression checks that disposal remains pending until then. The core's default fast-return cancellation mode remains available to other consumers. Neither behavior proves that the upstream stopped computation or billing.

## Executable App acceptance

`npm run verify:dsh-app` runs [the existing-browser acceptance entry](../bin/verify-dsh-app.mjs). It requires an already authenticated, debug-enabled browser on the existing App page and an installed `agent-browser` CLI. It never launches a browser/server, searches authentication tokens or personal profiles, exports auth state, or changes the target URL. Set `DSH_E2E_APP_URL` to that existing App origin without auth query parameters; `DSH_E2E_CDP` optionally identifies its already-enabled debugging endpoint. Do not enable a different server to satisfy the test.

Run one acceptance at a time, with a Session composer open:

```sh
# Prerequisite: DSH_E2E_APP_URL is set to your existing App URL.
npm run verify:dsh-app

# Open a WAV through the App's document-preview tab first. This invokes local
# playback/decoding, not cloud synthesis or an audio upload.
npm run verify:dsh-app -- --play

# Optional PAID/cloud test: empty idle draft, microphone permission available,
# selected oh-my-harness recognizer; speak this phrase during the recording.
DSH_E2E_EXPECT_TEXT='Native audio integration passed' \
DSH_E2E_RECORD_SECONDS=3 npm run verify:dsh-app -- --record
```

The default command checks UI prerequisites only. `--play` verifies the actual document-tab audio element loads and advances playback; physical speaker audibility remains a manual check. `--record` explicitly permits microphone capture and the configured cloud transcription request, then verifies the expected phrase appears once in the draft; it never sends the draft. Refusing a setup/connection precondition returns exit **2**, an executed failing check returns **1**, and passing the requested scope returns **0**. Reports contain status/codes, not URLs, draft text, credentials or raw browser diagnostics. A missing authenticated browser is a blocked receipt, not a passed mock E2E. This environment's executed precondition receipt is blocked at `EXISTING_BROWSER_UNAVAILABLE`; real browser playback/dictation has not passed here.

## Still separate deliverables

The capability bundle and optional speech registry/controller/voice adapter are installed and active in the desktop Host. Their client artifacts have been packaged and source-tested, but real microphone capture, browser audio decoding/playback and visual App acceptance remain open. Browser automation could not attach to a running debug-enabled browser; the existing authenticated App URL was not replaced by another server. Refresh the existing page to load the new client graph; do not promise build-watcher HMR without verifying that watcher.

A local XLSX fixture was created with formulas and successfully recalculated through the existing Office kit. Both formulas and cached values survived validation (line totals 6 and 4; grand total 10). A subsequent live cloud XLSX-understanding request returned HTTP 429; a post-upgrade cloud speech-synthesis attempt also failed. These failed attempts are not acceptance passes and are not silently retried. Earlier successful CSV/audio provider checks remain earlier-phase evidence, not proof of current upstream availability. Provider forms and light/dark icons remain unverified.

The recovered Native source and immutable-release suites pass independently against both dependency baselines. The locally active main-model route now selects the verified release matching its **actual normal ESM-resolved dependency identity**, not the App label by assumption. Previous release/config/package state is retained privately for rollback. Runtime activation is observed; a fresh paid main-model request/replay after cutover is still unverified. Installing the capability bundle is not the same operation as migrating that route. Do not patch the installed App archive or install a global resolver hook.

A local package upgrade can coincide with unrelated model catalog changes from another owner. Compare configuration semantically and apply a surgical entry update; do not restore an entire profile backup over new model declarations without confirmation. Keep model/endpoint configuration and rollback snapshots private. Non-core styling, richer settings and tab-state reuse are deliberately deferred rather than expanded into another round of UI work.
