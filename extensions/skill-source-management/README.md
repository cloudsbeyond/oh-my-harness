# Skill asset management and host discovery

[简体中文](README.zh.md) · [Design and boundaries](../../docs/skill-source-management.md)

This module manages reviewed **standalone** user Skills outside the project checkout. It publishes one physical source into `~/.agents/skills` and records how Codex and Claude Code discover it. The model proxy, MCP service and DSH runtime do not import it.

The initial implementation requires Python 3.11+ and has no Python package dependencies. Inspection is portable. Lifecycle mutations currently require **macOS**, because guarded directory replacement uses Darwin's exclusive rename and atomic exchange. Linux and Windows lifecycle support is not implemented.

This is not a drop-in replacement for an existing local manager. Foreign registry formats are refused before state initialization. Do not run the example against an existing installation without a separately reviewed migration.

## Try it in an empty temporary Home

Run from the repository root. This example creates a harmless candidate, then uses a temporary Home instead of your real installation.

```sh
DEMO="$(mktemp -d)"
export DEMO
mkdir -p "$DEMO/home" "$DEMO/candidate/shared-example"
cat > "$DEMO/candidate/shared-example/SKILL.md" <<'SKILL'
---
name: shared-example
description: Explain the shared-example lifecycle fixture
metadata:
  version: "1.0.0"
license: MIT
---
This is a harmless local fixture. Do not run tools.
SKILL

npm run --silent skills -- --home "$DEMO/home" \
  stage --source "$DEMO/candidate/shared-example" --origin example/skills --ref v1.0.0 \
  > "$DEMO/stage.json"

# Inspect the entire staged directory, including scripts/resources and license, before accepting it.
STAGED="$(python3 -c 'import json,os; print(json.load(open(os.environ["DEMO"]+"/stage.json"))["path"])')"
npm run --silent skills -- inspect --source "$STAGED"
STAGE="$(python3 -c 'import json,os; print(json.load(open(os.environ["DEMO"]+"/stage.json"))["stage"])')"
DIGEST="$(python3 -c 'import json,os; print(json.load(open(os.environ["DEMO"]+"/stage.json"))["fingerprint"])')"

npm run --silent skills -- --home "$DEMO/home" \
  install --stage "$STAGE" --expect-source "$DIGEST" > "$DEMO/install.json"
npm run --silent skills -- --home "$DEMO/home" \
  bind --name shared-example --client codex --expect-current "$DIGEST"
npm run --silent skills -- --home "$DEMO/home" \
  bind --name shared-example --client claude-code --expect-current "$DIGEST"
npm run --silent skills -- --home "$DEMO/home" audit
```

A digest proves the package still matches the inspected bytes; it does not perform a content, license or security review for you. `stage` and all lifecycle commands never execute candidate scripts or bootstrap installers. Publication makes instructions discoverable to consuming clients, which may then invoke them under their own policies.

## Client discovery

| Client | Default view | Unbind behavior |
| --- | --- | --- |
| Codex | Direct discovery of `~/.agents/skills`. No duplicate is created in `~/.codex/skills`. | Removes this manager's binding record, **not native discovery**. Returns `discovery_still_active: true`. |
| Claude Code | `~/.claude/skills/<name>` is a relative symlink to the central package. | Removes only the owned link and retains it in the receipt directory. |

With an explicit custom source root, Codex also uses a native-directory symlink. Native entries already present, including duplicate legacy Codex entries, are refused rather than overwritten. Skill triggering, permissions, native policy and model behavior remain client responsibilities.

Publishing to Codex's default discovery root can expose a Skill even before `bind`. To stop default discovery, withdraw the source after unbinding, or make a separately authorized change to the client's native policy. This module does not change that policy.

## Commands and state

Use `python3 extensions/skill-source-management/manage.py --help` or `npm run skills -- --help`.

| Command | Result |
| --- | --- |
| `inspect --source PATH` | Reads metadata and the complete-tree digest. Writes nothing. |
| `stage --source PATH --origin LABEL --ref REF` | Copies a local candidate into private staging outside discovery. Does not fetch remote sources. |
| `install --stage ID --expect-source SHA256` | Accepts the exact reviewed stage into an unoccupied source slot. Identical owned content is unchanged. |
| `update --stage ID --expect-source SHA256 --expect-current SHA256` | Exchanges the source after checking both reviewed digests. Retains the previous package. |
| `bind --name NAME --client CLIENT --expect-current SHA256` | Records direct discovery or creates one owned symlink. |
| `unbind --name NAME --client CLIENT` | Withdraws an owned binding, without deleting central source. |
| `uninstall --name NAME --expect-current SHA256` | Withdraws an owned source after unbinding and checking known client consumers; retains a backup. |
| `verify --receipt PATH` | Checks completed operations or reports interrupted phases and actual filesystem/registry facts. |
| `rollback --receipt PATH` | Selectively reverses a completed or known-published operation if history, content and ownership still match. |
| `audit` | Checks owned records and lists unmanaged visible entries in selected roots. Does not adopt them. |

Global options `--home`, `--source-root` and `--state-root` precede the command. Home must already exist. Source and state roots must be disjoint real paths inside it and must not overlap native discovery directories. Use a single private state root per accepted source root. Cooperating processes using that state serialize through a bounded lock. This is not protection against arbitrary same-user processes.

```text
<home>/.agents/
  skills/
    .source-registry.json          omh-skill-sources-v1, accepted source evidence
    <name>/                        complete standalone Skill source
  skill-management/
    manager.lock
    ownership.json                 omh-skill-state-v1, client/history ownership
    staging/<id>/                  candidate package and stage metadata
    receipts/<id>/receipt.json      omh-skill-operation-v1
    receipts/<id>/original/         retained previous source, when applicable
```

Source evidence contains origin/ref, declared version evidence, license evidence and fingerprint. Private paths and client bindings stay in state and receipts. Records are validated before they select a filesystem target. They are not signed or a security boundary against the Home owner.

Git is optional and manual. Only accepted sources and their source registry belong in a source Git repository. Do not version staging, receipts, credentials or runtime environments. The module does not initialize Git, stage changes, commit or push. Existing proprietary Skills are not included with this open-source module.

## Recovery and limits

- Drift, foreign registries and unowned destinations are refused. No fallback publishes a native editable copy.
- Interrupted same-Skill receipts block further publication and binding mutations until guarded rollback or manual reconciliation. Audit reports these receipts instead of reporting a clean state.
- Withdrawal checks every symlink in the supported native roots, including aliases with other names, before moving source. It does not inspect unsupported clients or arbitrary filesystem references.
- Rollback preserves unrelated later installations. Later changes to the same target or backup block reversal.
- A `published` interruption means filesystem publication completed but metadata may be partial. Inspect `verify` before attempting guarded rollback.
- `preparing`, `publishing`, `reversing` and `reversed` interruptions need **manual reconciliation**. Do not replay the operation. Retained payloads and receipt facts help identify what happened. Filesystem and multiple JSON files are not one crash-atomic transaction.
- Inspection fingerprints paths, types, modes, file bytes and internal relative links. It rejects escaping/broken links, common credential/runtime payload names, native plugin markers and nested `SKILL.md` packages. Ignored development metadata includes `.git`, `.DS_Store`, Python caches and bytecode.
- Limits are 64 MiB, 10,000 entries and a real UTF-8 `SKILL.md` up to 1 MiB. Metadata extraction is deliberately minimal, not complete YAML/Agent Skills specification validation or a complete secret scanner.
- `audit` does not inspect hidden built-ins, plugin caches, project Skills, every process or other client roots. `verified` refers to owned records, not full-machine coverage or business execution.
- Whole plugin publication/cache adaptation, TRAE clients, remote acquisition, Hook interception/trust, native enable/disable policy, Git checkpoints and strict OS isolation are deferred. Do not centralize a plugin by splitting its exported Skills through this standalone adapter.

## Verification

```sh
npm run test:skills
npm test
# Opt-in native tests. Installed client binaries are found on PATH.
OMH_SKILL_NATIVE_TESTS=1 npm run test:skills
```

You may set `OMH_CODEX_BIN` and `OMH_CLAUDE_BIN` to explicit binaries. Missing clients skip only their native test. Each phase uses generated temporary Homes, fresh client processes and no real provider credential.

Codex verification calls `skills/list` via app-server without starting a thread or model turn. Claude verification invokes a harmless fixture Skill against a loopback Anthropic response fixture and checks that the outgoing request contains the central body after install/update/rollback, and no body after unbind. It does not verify production model judgment or candidate tool execution. The tests do not bypass Hook trust or managed security policies.

## Development and contributions

The module uses the repository's [MIT license](../../LICENSE). It does not change the license of managed third-party or private Skill content. Keep changes within standalone-package lifecycle or explicit client-view adapters; do not add plugin, Hook or account authorization to the manager.

Include isolated regression tests for behavior changes. Use temporary Homes, never a maintainer's real installation. Default tests need no agent account or API credential. CI runs Python 3.11 and 3.14 on macOS, Linux and Windows. macOS exercises lifecycle writes; the other platforms check inspection and refusal before initialization. Native-client tests remain explicitly opt-in and local; CI does not install clients or provision provider credentials.

Public packages contain source, tests and general documentation, not local execution plans, handoff notes, candidates, receipts or runtime state.
