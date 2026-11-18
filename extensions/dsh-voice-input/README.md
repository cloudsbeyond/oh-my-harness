# Native voice input bundle

Experimental, optional add-on for the oh-my-harness capability bundle. It reuses the Host's experimental speech-to-text registry, generated speech Remote and composer voice-input slot; it does not install the official voice bundle and does not activate SenseVoice.

## What it adds

- A cloud STT provider (`oh-my-harness`) registered on `speechToText`, delegating to the shared `omhCapabilities` runtime's `speech.transcribe` operation default. Replacing that default replaces the transcription engine without changing this UI.
- Strict adaptation of the Host's canonical 16 kHz mono PCM16 WAV recording to the capability core's 24 kHz contract, with a 40 second recording limit (the resampled PCM stays inside the core's 2 MiB audio bound).
- A composer microphone activity with cancel/stop, Escape/blur/visibility cancellation, and draft insertion that never submits automatically.
- Settings/activation cards registered under this bundle's own key; their configuration link opens the `oh-my-harness` capability bundle, where provider/default settings belong (never the official voice bundle).

## Requirements and limits

- Requires the separately installed `oh-my-harness` capability bundle (declared as an optional package-manager peer to avoid fetching an unpublished package, but required at runtime to provide `omhCapabilities`) and a configured `speech.transcribe` default with resolved credentials. Install the local capability bundle first; this add-on does not fetch or configure it. Both Host speech package peers are optional for the package manager too: use the DSH installation's existing packages, not a second runtime copy. The `speechToText` and `omhCapabilities` injections remain mandatory at runtime.
- The add-on owns the speech registry/controller in its Host composition. Do not activate a second speech registry/controller or the official voice bundle alongside it. An already mounted browser speech Remote is reused rather than mounted twice.
- The composer follows Host readiness across reconnects and accepts only the selected `oh-my-harness` speech adapter. Other recognizers and their model-preparation UI are outside this add-on; replacing the capability backend's operation default remains supported.
- Cloud-only: no local model preparation. Only automatic language detection is advertised; selecting another language is rejected rather than ignored.
- `inferenceSeconds` is measured end-to-end and includes transport; it is not GPU-only timing.
- Microphone permission, recording quality and rendered appearance are runtime acceptance checks; local tests cover the adapter, resampling, cancellation and artifact registration only.

## Upstream attribution

The recorder/WAV encoding and microphone-to-draft flow are adapted from the MIT-licensed `@deepseek-ai/dsh-experimental-client-ui-voice-input` 0.2.2-rc.3 sources (`audio.ts`, `VoiceInput.tsx`, `mount.ts`) in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This package retains the DeepSeek copyright and MIT permission notice in [LICENSE](LICENSE). Provider routing, format adaptation and this package's composition/settings ownership are specific to oh-my-harness.
