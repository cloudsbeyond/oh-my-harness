# Provider configuration

The registry connects a model ID from CLIProxyAPI to the capabilities oh-my-harness should expose. Enable a capability when your authorized account, model and CLIProxyAPI route support the corresponding request. The registry also selects the models offered by the DSH integration.

1. Configure the provider in CLIProxyAPI and check its authenticated `/v1/models`.
2. Add a provider ID under `providers`. Set `protocol` to `responses`, `chat`, or `messages` based on its API route. Add one or more advertised model IDs with their context window and output limits. Use CLIProxyAPI aliases for models that would otherwise have the same ID.
3. Enable the capabilities you intend to use and set `defaults` for each enabled capability. The `text` capability makes a provider available to DSH for conversation. Tools can select a configured `provider` and, where applicable, a `model`.
4. Restart the Capability Proxy and relaunch DSH to apply changes.

`npm run init` copies the [Codex and Kimi defaults](../config/default.json) to `.state/config.json`. Set `OH_MY_HARNESS_CONFIG` to load another complete config. The [multi-provider example](../config/providers.example.json) is an independent config with illustrative model IDs and limits. Replace them with the IDs and limits for your upstream.

For a DSH conversation that uses Kimi and a search tool that uses Codex, set `defaults.text` to `kimi` and `defaults.search` to `codex`. Both accounts need the corresponding access in CLIProxyAPI.

| Capability | Tools and inputs |
| --- | --- |
| `search` | `web_search` takes a `query` and optional `url` and `find`. Set provider `search` to `responses` or `messages`. Responses checks for an exact page action when given a URL. Messages uses URL and find as search hints. |
| `vision` | `inspect_image` takes `image_base64`, an optional `second_image_base64`, and `question`. PNG, JPEG, or WebP, up to 5 MiB total. |
| `documents` | `inspect_document` takes `filename`, `file_base64`, `question`, and optional PDF `detail`. The Responses adapter accepts PDF, DOCX, XLSX, PPTX text, and UTF-8 CSV. |
| `video` | `inspect_video` takes `filename`, `file_base64`, and `question`. The Chat adapter answers from visible content in a short MP4. |
| `images` | `generate_image` takes `prompt`. `edit_image` also takes `image_base64`. Set `imageModel`. The Responses adapter uses its image tool and the other protocols use the Images API. |
| `audio` | `synthesize_speech` takes `text`. `transcribe_audio` takes `audio_base64`. `ask_audio` adds `question`. Set `realtimeModel` and `transcriptionModel`. Input audio uses 24 kHz mono PCM16 WAV, at least 100 ms and at most 2 MiB of PCM. |

Document and video inputs are limited to 5 MiB. DSH passes `file` and, for image comparison, `second_file` through the local adapter. Direct MCP clients use the Base64 inputs above. `list_providers` shows the configured providers, model IDs and enabled tool capabilities. Test capabilities on your upstream with representative inputs.

Provider API keys and OAuth login live in CLIProxyAPI. Add the relevant key group to its private configuration or use its login command. [CLIProxyAPI provider and key examples](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.51/config.example.yaml)

## Extend capabilities

1. **Choose the source and contract.** Identify one tool the client needs and confirm the authorized upstream can perform it. Reuse the existing MCP name and schema when the capability already exists. Capture a small sanitized request and response as fixtures.
2. **Choose the adapter.** For a compatible provider behind CLIProxyAPI, try a provider registry entry first. For a new provider protocol or tool, add an adapter in [the tool implementation](../src/tools.mjs) or [the Realtime implementation](../src/realtime.mjs). For an independent harness, implement a direct MCP or HTTP adapter using its own URL and credential configuration. The existing `upstream` setting remains the CLIProxyAPI route.
3. **Keep the client contract stable.** Validate inputs, media size, and upstream result shape. Map errors and timeouts to MCP errors. Update [the stdio adapter](../src/stdio.mjs) when a tool needs local file inputs or outputs. Keep credentials in runtime state.
4. **Verify before enabling.** Test routing and result handling with sanitized fixtures in [the gateway tests](../test/gateway.test.mjs). Run `npm test`, check discovery with `npm run doctor`, then invoke the tool against your authorized upstream. Document the required access and select a default only after the route works.
