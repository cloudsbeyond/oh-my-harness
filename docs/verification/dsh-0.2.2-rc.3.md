# DSH 0.2.2-rc.3 verification record

[Host integration methods](../dsh-integration.md) · [Native bundle](../../extensions/dsh-capabilities/README.md)

Results apply to the named source/host checkpoint. Historical provider success is not a current health check; fixture, discovery, execution and UI results are recorded separately.

## Reproduce the relevant checks

```sh
npm test
npm run verify:package
npm run test:skills
# Requires the reviewed, isolated dependency/build/state setup linked below:
npm --prefix extensions/dsh-native-codex run build
npm --prefix extensions/dsh-native-codex test
```

[Native Codex baseline and release tests](../../extensions/dsh-native-codex/README.md#build-without-modifying-the-host) · [Opt-in Skill discovery tests](../../extensions/skill-source-management/README.md#verification). Root tests and package verification do not start a host or validate its active model route.

## 2026-11-18 isolated alignment checks

| Check | Observed result | Scope |
| --- | --- | --- |
| Root Node suite | 171 passed on Node 24 and 26 | Local core/MCP/host-adapter and packaging fixtures |
| Generated client and actual package | Passed | Reproducibility, files/exports/licenses, privacy rules, relative imports and detached client build |
| Native Codex, external SDK baseline | 50 source + 50 immutable-release cases passed | SSE, replay, guarded retry and tool-once behavior |
| Actual Host SDK interfaces | 5 passed | Installed DSH 0.2.2-rc.3 interfaces with isolated fixture services |
| Generated Web profile | Composed in DSH 0.2.2-rc.3 | Temporary Home and synthetic keys; no service/model request |
| Skill lifecycle and native clients | 40 passed, 1 platform skip | Fresh temporary Codex/Claude processes and local protocol fixtures |

No running installation or user asset source was replaced. ASAR acceptance below belongs to the earlier checkpoint.

## Earlier checkpoint: `2c60bf0`

| Boundary | Recorded result | Limitation |
| --- | --- | --- |
| Automated fixtures | Root 131; Host SDK 5; realtime 5; Native source/release 50 each on App/ASAR and external baselines | Offline checks; test counts are not coverage percentages |
| Host lifecycle | Cordis/Fiber and speech contribution teardown passed | Simulated client services, not browser UI |
| CSV understanding | Expected total of 10 returned | Historical authorized provider invocation |
| Image generation → understanding → editing | Original PNGs and same-session follow-up passed, including provider switching | Not visual preview/download acceptance |
| WAV synthesis → transcription; audio/video understanding | Original WAV transcribed to the spoken sentence; audio question answered; video described as red → green → blue | Historical provider availability only |
| Search and deterministic fetch | Attributable search sources and separate HTTP 200 fetch | Different contracts, both tested |
| File admission | Outside-workspace source rejected | Cloud-upload boundary |
| Local spreadsheet editing | Recalculated line totals 6 and 4, grand total 10 | Later cloud XLSX understanding returned HTTP 429 |
| Subsequent cloud speech synthesis | Failed | Earlier audio success does not override this failure |
| Main-model route activation | Observed against actual dependency identity; rollback retained | Fresh paid request/replay after cutover was not verified |
| Browser acceptance | Blocked: `EXISTING_BROWSER_UNAVAILABLE` | Playback, microphone, rendered configuration/icons and HMR remain unverified |

## Executable App acceptance

Use an **existing authenticated, debug-enabled App page** with `agent-browser` installed. Set `DSH_E2E_APP_URL` to its origin without auth parameters; optionally set `DSH_E2E_CDP` to its existing debugging endpoint. The runner does not create another browser/server, find tokens or export authentication.

```sh
npm run verify:dsh-app         # UI prerequisites only
npm run verify:dsh-app -- --play  # first open a WAV in the document-preview tab
# Explicit opt-in: microphone and configured cloud transcription; idle empty draft:
DSH_E2E_EXPECT_TEXT='Native audio integration passed' DSH_E2E_RECORD_SECONDS=3 npm run verify:dsh-app -- --record
```

`--play` checks decoding and playback progress; speaker audibility is manual. `--record` checks one transcription insertion without submitting. Exit codes: **0** passed, **1** executed check failed, **2** prerequisite blocked. Reports omit credentials and user content. Source registration tests cannot close these UI acceptance gaps.
