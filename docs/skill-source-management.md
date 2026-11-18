# Skill assets and host discovery

[简体中文](skill-source-management.zh.md) · [Architecture](architecture.md) · [Commands and state layout](../extensions/skill-source-management/README.md#commands-and-state)

## Purpose and supported scope

The manager connects one reviewed, versioned Skill source to each supported host's discovery mechanism. It prevents independently editable copies from drifting while leaving triggering, tools and permissions with the consuming harness. It runs independently of model and capability requests.

The current implementation manages **standalone Skills**, with Codex and Claude Code discovery adapters. Python 3.11+ inspection is portable; lifecycle writes require macOS. Local candidates are supported; remote acquisition, complete plugin/cache management and hosted distribution are deferred. Existing managers, registries and native policies are not adopted automatically.

## Design invariants

- **One publication unit:** review the complete Skill, resources and license. Do not split an incompatible plugin to make it appear supported.
- **Explicit identity:** retain origin/ref, declared version, license evidence and accepted digest separately. Digests include paths, modes, bytes and relative links; they detect drift, not trust or execution authority.
- **Separate source and state:** accepted assets live outside this checkout; staging and operation receipts stay outside discovery and source Git. Private Skills retain their own licenses and visibility.
- **Guarded changes:** publication uses the reviewed candidate digest; update also checks the expected current digest. Preserve earlier content and refuse foreign destinations, later edits and changed backups.
- **Owned discovery:** bind only supported entries or records. A host may scan an accepted root before bind; for default Codex discovery, unbind alone does not stop scanning.
- **Recoverable lifecycle:** package replacement, registry updates and client bindings are not one atomic transaction. Reconcile interrupted receipts before retry. Manager locks do not isolate arbitrary same-user programs.

Commands, actual directory layout, client-specific unbinding and recovery procedures have one owner: the [module README](../extensions/skill-source-management/README.md).

## Acceptance and implementation sequence

Verify each boundary independently:

| Boundary | Required evidence |
| --- | --- |
| Source | Reviewed identity, content and license; no runtime or credential leakage |
| Lifecycle | Update, drift refusal, rollback and interruption handling in temporary Homes |
| Discovery | Correct accepted content and withdrawal behavior in a fresh client process |
| Execution | A separately authorized representative use; shared files do not guarantee equal model behavior or permissions |

[Verification commands and native-client fixtures](../extensions/skill-source-management/README.md#verification) distinguish discovery/body injection from business execution.

## Extension rule

Add an adapter only after verifying the target host's real discovery contract. Reuse its supported loader and lifecycle, preserve source identity and owned-entry withdrawal, and test with temporary state. Additional clients/platforms need their own evidence; accepting a package does not authorize hooks, credentials or permission changes. [Shared extension workflow](providers.md#extension-workflow)
