# Optional DSH Codex native adapter

This extension keeps Codex-native search citations and generated images in a DSH conversation. DSH owns sessions, replay and attachments; the extension submits Responses requests to the configured model proxy. It is separate from the provider-neutral [capability core](../../docs/capabilities.md), whose operations can be invoked independently from the main conversation model.

Native search and image generation participate in the main model request. Do not invoke a second host capability for the same work. Title/compaction requests skip native search by default. Successful image calls deliver an original PNG plus a normalized attachment for follow-up; image requests do not inherit chat reasoning settings.

## Reviewed host baselines

The adapter patch is locked to **DSH 0.2.2-rc.3** and upstream adapter SHA-256 `e956da3d7300e1426e13e14f47e6f981dd1ca345633a406568ee5058ad93e9d8`. Any other adapter requires review before building. The patch preserves this host version's request-header preparation and replay digest.

Two dependency variants have been tested separately:

| Host input | pi-ai | Built-source suite | Immutable-release suite |
| --- | --- | --- | --- |
| Desktop App / ASAR | 1.3.0 | passed | passed |
| External installed dependency tree | 1.5.2 | passed | passed |

Both use dsh-llm/llm-pi-ai 0.2.2-rc.3, Cordis 4.1.0 and Schemastery 3.19.0. This table reports offline fixtures, not paid-provider or GUI acceptance. See [DSH integration decisions](../../docs/dsh-integration.md) for the tested boundary.

Each build records the actual ESM-resolved versions, package-manifest hashes and entry-file hashes of those five packages. Dependency identity is part of the immutable release content, so the variants have distinct release IDs even when the generated adapter text is identical. Activation rejects a mismatched fingerprint before registering a model route.

This is a checked compatibility fingerprint, not a complete hermetic lock of every transitive file, the OS, runtime or provider behavior. Keep the installed dependency tree reproducible through its own package/distribution lock as well.

## Build without modifying the host

From this extension directory, set an absolute host `node_modules` path, separate build output and separate extension release state:

```sh
export DSH_NODE_MODULES=/path/to/installed/dsh/node_modules
export DSH_NATIVE_BUILD_DIR="$PWD/.build"
export DSH_NATIVE_STATE_DIR="$PWD/.state-native"

npm run build
npm test
NATIVE_TEST_RELEASE=1 npm test
```

Use Node.js 24+. No dependency symlink is required for these build/test commands. The explicit `host-loader.mjs` selects host packages while preserving ESM import conditions: pi-ai does not provide a `require` entry or a public `package.json` export. Merely setting `DSH_NODE_MODULES` is not enough to change Node's normal bare-import resolution.

For an App installed in `app.asar`, an ordinary Node executable cannot read inside the archive. Run the same steps with the ASAR-aware runtime exposed by DSH:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
  --import ../dsh-native/host-loader.mjs build-adapter.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" build-release.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
  --import ../dsh-native/host-loader.mjs --test *.test.mjs
NATIVE_TEST_RELEASE=1 ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
  --import ../dsh-native/host-loader.mjs --test *.test.mjs
```

The loader only belongs to explicitly launched build/test processes. **Do not install a global resolver hook into a running App.** Runtime installation must resolve the same dependency identity through the host's normal plugin/package integration; changing an environment variable does not provide that installation.

Build outputs include the generated adapter, its MIT license, dependency fingerprint and a staged copy of runtime source. Source files and installed host files are not overwritten. The release builder reads that staged build, creates a content-addressed directory and updates only `DSH_NATIVE_STATE_DIR/release-manifest.json`. Use a scratch state directory for experiments rather than a live release state.

## Configure a route

In a composed DSH profile, insert the manifest's `entry` file URL as a plugin. Move the selected Codex provider declaration from `llm-pi-ai.config.providers` into this entry's `config.providers`; retain its route ID, models, limits and credential reference. Keep other providers in the stock adapter. Do not duplicate registration of the same route.

The route requires `api: openai-responses`, an HTTPS or loopback HTTP `/v1` base and a DSH credential reference. The plugin resolves that reference through the host credential service; it does not read another application's login files.

Set `nativeSearch.enabled: true` for main-request search. Images are enabled by default and can be disabled with `nativeSearch.images: false`. Image tool authorization is intent-gated; it is not an unconditional generator for every image-related question.

Run the composed-profile check and source/release fixture suites before changing a running profile. Preserve the previous entry and dependency baseline for rollback. A new release manifest alone is not proof that the App has loaded it.

## Transport and replay safety

- A client request ID is distinct from session-affinity headers; a safe server request ID is retained for diagnosis.
- Network and SSE-read failures can retain a bounded cause code without copying raw exceptions into the conversation.
- Visible output, observed native search/image work or an authorized image request make retrying an interrupted attempt unsafe. The selected route's retryable failures become `TRANSPORT_INTERRUPTED`; this covers default `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER` and `TIMEOUT` as well as `TRANSPORT`. Safe original codes remain in bounded diagnostics. A completed native search followed by a real SDK server-timeout event is an explicit regression fixture.
- Explicit cancellation is not relabeled as a retryable connection failure.
- Failed/incomplete responses do not publish generated images. Partial SSE is tested not to become a successful completed answer.
- Replay has its own metadata validation and text-only degradation rules when history/model/anchors change. Working HTTP calls do not prove replay correctness.

The adapter does not promise that cancellation reverses upstream computation or billing. It does not implement voice, arbitrary file understanding or a spreadsheet editor; those capabilities use separate host/provider integrations.
