# DSH native extensions

A native extension is installed on the DSH host and loaded by DSH through its profile. The plugin registers its provider routes with the DSH runtime and handles request adaptation, stream events, replay, and attachments. It sends model requests to the provider URL in the profile. DSH's stock adapter serves the remaining providers, and MCP clients connect to the Capability Proxy independently.

To add an extension, create a sibling directory and give it a DSH plugin entry and tests for its provider. If it adapts an installed DSH dependency, pin that dependency and verify its fingerprint in the extension's build. Use `publishRelease` from [release.mjs](release.mjs) with an explicit map of files and an entry filename. It writes an immutable release and a manifest containing the entry file URL. Give each extension a separate state directory.

Load the resulting entry through a DSH profile, and keep provider IDs, model choices, endpoints and credential references in that profile. Check that the extension and stock adapter each own their intended routes, then exercise native behavior and ordinary function calls. [Codex example](../dsh-native-codex/README.md)
