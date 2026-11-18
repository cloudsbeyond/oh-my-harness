# Cloud speech provider for DSH Voice input

This optional Host-only add-on registers the `oh-my-harness` cloud recognizer with DSH's official **Voice input** bundle. The official bundle owns the speech registry, browser interface, microphone and local SenseVoice. There is one composer microphone and one recognizer selector.

## Install and switch

1. On DSH 0.2.2-rc.3, enable **Voice input** and install the [oh-my-harness capability bundle](../dsh-capabilities/README.md). Configure a usable `speech.transcribe` default in the capability bundle.
2. Install/enable this add-on **after** the official bundle in the profile's bundle order. If upgrading a profile that listed this add-on first, disable and re-enable this add-on to append it after Voice input. The order applies a limit to the official controller; it does not mount a second controller.
3. In **Plugins → Voice input**, choose **SenseVoiceSmall (INT8)** for local recognition or **oh-my-harness** for cloud recognition. If the local language was pinned, set it to **Auto** before switching to cloud. The add-on does not override the official default or your saved choice. Choose the local recognizer before disabling the cloud add-on.

Only the selected cloud recognizer sends audio to its configured provider. There is no cross-provider fallback. The official UI inserts the transcript in the draft; it does not send a message. A cloud readiness card alone does not prove that credentials or the upstream transcription service work.

The shared controller caps microphone recordings (both modes) at 40 seconds while this add-on is enabled. The adapter converts canonical 16 kHz mono PCM16 to 24 kHz to stay within the capability core's 2 MiB audio limit. `inferenceSeconds` includes transport. This repository tests provider registration, input conversion, routing and cancellation; physical microphone and provider acceptance are installation-specific. The [MIT notice](LICENSE) retains attribution for the upstream voice integration.
