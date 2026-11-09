# Optional DSH Codex native adapter

Install this adapter on the DSH host to keep native search citations and generated images in GPT conversations. The DSH Web profile loads the plugin, which registers the configured provider IDs with the DSH runtime and submits Responses requests to the Model Proxy. DSH owns the session, replay, and attachment store. The [Capability Proxy](../../docs/providers.md) also exposes search, image generation, and editing over MCP for conversations using other providers.

A successful native image call delivers the original PNG and a normalized attachment for follow-up. The adapter omits the chat reasoning setting from image requests. Search citations and replay use DSH's existing response metadata. Title and compaction requests skip native search by default.

## Build against the installed DSH version

The build checks the DSH 0.2.1-rc.5 pi adapter hash. A mismatch requires reviewing the extension against that DSH release. The build reads the installed adapter and writes a separate copy.

Run this from this extension directory in a writable checkout. Set `DSH_NODE_MODULES` to the absolute directory containing the installed DSH packages, and `DSH_NATIVE_STATE_DIR` to the deployment's extension state directory. Use the same DSH dependency tree for the build and the running plugin.

```sh
mkdir -p "$DSH_NATIVE_STATE_DIR"
ln -s "$DSH_NODE_MODULES" node_modules
ln -s "$DSH_NODE_MODULES" "$DSH_NATIVE_STATE_DIR/node_modules"
npm run build
npm test
NATIVE_TEST_RELEASE=1 node --test plugin.test.mjs
```

On subsequent builds, reuse the links if they still point to the installed DSH packages. The build writes an immutable release and a `release-manifest.json` to `DSH_NATIVE_STATE_DIR`. Keep the generated adapter, dependency links and release state outside tracked source.

In your DSH Web profile, insert a plugin entry whose `name` is the manifest's `entry` file URL. Move the selected Codex provider declaration from `llm-pi-ai.config.providers` into this entry's `config.providers`, retaining its ID, models, limits and credential reference. Keep the other providers in the stock adapter. The Codex provider must use `api: openai-responses` and an HTTPS or loopback HTTP `/v1` base. Set `config.nativeSearch.enabled: true` to enable native search. Native image generation and editing are enabled by default and can be disabled with `config.nativeSearch.images: false`.

Run DSH's composed-profile check before updating the running profile. In a fresh Web session, select a GPT model from the configured provider and verify a native search with a source citation and a follow-up. Then request an image and check the preview, original PNG, and a follow-up about the image. These checks exercise the active DSH runtime. For rollback, point the profile back to the previous release entry.
