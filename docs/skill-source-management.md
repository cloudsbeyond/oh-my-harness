# Shared Skill source management

[简体中文](skill-source-management.zh.md) · [Architecture](architecture.md)

**Status: initial optional implementation, with a broader design below.** The [local CLI module](../extensions/skill-source-management/README.md) implements reviewed standalone packages and Codex/Claude Code views on macOS. Complete plugin adapters, TRAE views, remote acquisition, native policy and Hook management remain design scope, not implemented features. No endpoint or model/MCP configuration is added.

## Goal and project fit

Make third-party and personal Skills reusable across local agents without maintaining separate editable copies, choosing versions by name, or repeating each client's installer logic. The intended result is one accepted source per publication unit, explicit version evidence, and independently verified client entry points. Sharing bytes does not make agents choose or execute a Skill identically.

This complements oh-my-harness's provider-neutral capability core, which now has MCP and native DSH entry points, but solves a different problem:

| Concern | Owner |
| --- | --- |
| Model inference and provider authentication | Model Proxy or the configured model service |
| Executing provider or independent-harness tools | Capability execution core and its MCP/native adapters |
| Publishing Skill instructions and resources for local discovery | Optional client-side source manager described here |
| Triggering a Skill, granting tools, and executing its workflow | The consuming agent or harness |

A Skill is an instruction/resource package, not an executable MCP tool contract. The source manager must not turn every Skill into a provider capability, load all Skill bodies into each request, or make the capability core or Model Proxy depend on Skill installation. The existing [runtime diagram](architecture.json) remains unchanged because this design is outside that request path.

The open-source repository owns the reusable design and optional manager code. It is not the user's shared installation directory. Accepted user packages belong in a user-controlled source root; private Skills need not become public just because the manager is open source.

## Scope and non-goals

P0 covers user-level third-party and personal Skills, including complete redistributable packages whose entries can be adapted without maintaining a second source. Project-only Skills remain project-local unless the operator chooses otherwise.

Keep runtime-owned built-ins, managed company hooks, accounts, credentials, model configuration, MCP connections, and agent permissions under their existing owners. A package containing scripts is not automatically agent-coupled; assess its actual API, path, tool, and invocation dependencies. Conversely, matching `SKILL.md` files do not make two complete plugins interchangeable.

Do not introduce per-agent source forks under `.variants` or client-suffixed directories. Do not centralize an incompatible version merely to make the directory inventory look uniform. Preserve unresolved originals and backups outside active discovery until an explicit decision is made.

## Source and state layout

The reference policy uses `~/.agents/skills` for accepted sources. A reusable implementation should allow an explicit source root rather than hard-code a person's home directory.

```text
~/.agents/
  skills/                         accepted editable sources
    .git/                         source history, not operation history
    .source-registry.json         source identities and owned exports
    shared-review/
      SKILL.md
      scripts/
      references/
      assets/
    workflow-suite/                one complete publication unit
      .plugin-source.json
      .source/                    accepted package snapshot, not agent variants
  skill-management/               outside Skill discovery and source Git
    staging/                      unaccepted candidates
    receipts/
    backups/
```

Registry and package-marker filenames illustrate the reference design; they are not additions to the Agent Skills standard. Hidden accepted package snapshots preserve whole-package identity without exposing every embedded Skill as an unqualified top-level command. An ordinary Skill stays a direct child with its complete resources.

Installed environments, dependency caches, credentials, operation receipts, and backups do not enter source Git. A sanctioned compatibility view may link an existing runtime separately, but that does not make the runtime part of the Skill publication unit. The open-source project's MIT license does not relicense third-party or proprietary Skill content.

## Identity and version decisions

Record upstream origin and pinned ref, declared Skill version, package/marketplace version, installation provenance, reproducible content digest, and the accepted source identity separately. They answer different questions. Neither the largest version number nor the newest modification time identifies the right source.

Compare the full publication unit: instructions, scripts, references, assets, manifests, license, entry-point syntax, and required tools. A content digest must account for executable modes and link targets as well as bytes. Its exclusions and algorithm must be documented. A digest detects drift; it is not a publisher signature or permission to execute code.

For same-named entries, distinguish identical content, generated host syntax, intentional differences, and runtime coupling. Unresolved semantic or permission differences block automatic replacement. Put reviewed host adaptation in the shared package or deterministic entry generator, not in independently editable copies. Retain upstream identity separately from the adaptation version.

A full plugin or workflow suite is one source/version unit. Its subskills and public aliases are owned exports, not packages that can be updated independently. Preserve internal relative references and native command namespaces.

## Acquisition, publication, and updates

The following are proposed operations, not commands supplied by this release:

1. **Inventory.** Read sources, real paths, links, policy ownership, and native runtime discovery. Do not classify compatibility from names alone.
2. **Stage.** Acquire an exact upstream ref or a complete local candidate outside every active Skill scan root. Do not run its bootstrap or installer.
3. **Review.** Compare full content, version evidence, licenses, dependencies, invocation changes, and requested authority. Obtain decisions for risky differences.
4. **Publish.** Recheck the reviewed candidate digest and, for updates, the expected current digest. Publish the complete package to the central source root and retain the prior package and phase receipt.
5. **Bind.** Create or reconcile only the selected client's owned links or compatible generated view. Check the expected original before replacement; preserve conflicts and unrelated configuration.
6. **Verify.** Check source, bindings, native discovery in a new process, then one authorized representative invocation. Report each result separately.
7. **Checkpoint.** Stage accepted sources and owned metadata for review. Commit and push only under their own authorization; a staged tree is not Git history.

Publication must not remove the central target before linked readers can obtain the replacement. The local reference implementation uses guarded directory exchange on macOS; portable equivalents require separate verification. Package exchange, registry updates, and native client configuration are not one global atomic transaction. Use receipts to record intermediate states, single-writer coordination for shared targets, and expected-version checks for configuration.

Rollback reverses only changes owned by that receipt and refuses to overwrite later edits, changed backups, or retired link targets. An unknown or interrupted result requires readback and reconciliation before retry. No recovery command should blindly restore an old whole-user configuration.

## Client discovery and compatibility views

Central storage is not a universal scan configuration. Determine each client's actual loader, active scope, installed version, and invocation rules.

| Client | Discovery or binding approach | Required check |
| --- | --- | --- |
| Codex | Current documentation includes `~/.agents/skills` directly. Use legacy native entries only when required and reconcile duplicate visibility. | Both same-named entries may remain visible; source location alone does not choose one. |
| Claude Code | Its documented personal root is `~/.claude/skills`. Bind shared sources using a verified link or supported loading mechanism. | Preserve frontmatter, arguments, dynamic commands, plugin namespaces, and invocation restrictions. |
| TRAE IDE and CLI | The reference local arrangement uses `~/.trae/skills` for both. Discover the actual configured root rather than treating this as a platform guarantee. | One writer for a shared directory; the other client verifies. Preserve native manager ownership. |
| TRAE CN | The reference local arrangement uses `~/.trae-cn/skills`; binding needs its own runtime check. | Confirm loading and manager/update behavior instead of inferring it from IDE behavior. |
| Other harnesses, including DSH | Use the harness's supported Skill loader or host adapter. | An MCP connection does not establish filesystem Skill discovery. |

Expose the chosen shared subset only where the client has the required tools and compatible semantics. A capability intersection compares content and dependencies, not just displayed names. Do not disable an entire plugin to hide a duplicate export, or expose every package-internal `SKILL.md` recursively without an export policy.

Prefer a per-Skill directory link. Where an existing executable path needs a different shape, a managed view may link instructions/resources and a separately owned runtime. Record and verify every owned path; refuse unknown files rather than replacing the view wholesale.

Native plugin caches may remain materialized. When a client requires native installation, derive its cache from the accepted whole package using its supported lifecycle. Preserve namespace, enablement, and trust state. The goal is one editable source, not zero physical cache copies.

## Keep future installs centralized

One migration is insufficient if a later installer recreates native copies or writes through a link. Acquisition, installation, update, reinstall, and uninstall need a single source-management entry point, with adapters for the existing installer or generator. New-source publication and client binding remain separate operations.

Document the policy in each agent's user-level instructions. Redirect a helper only through its supported destination option, and stage outside discovery. Do not repoint an entire agent home to move its credentials and runtime along with Skills. If the manager is unavailable or verification fails, retain the candidate/original and stop publication; do not silently fall back to a native editable directory.

Complete plugin support is deferred in the initial module. Its future adapter should separate source binding from native cache refresh. Update only the exact owned catalog/config entry with expected-version guards. Do not remove and reinstall an entire marketplace to replace one source. Changes to Hook, MCP, app, or agent contracts require their own review.

## Trust, authority, and failure boundaries

An optional pre-tool guard can reject recognized raw installers and writes to managed native entries. It must be explicitly enabled and trusted. Non-blocking output should leave ordinary approvals unchanged, not approve the request. Pin and review the executed guard code and verify live native trust after changes.

This is a guardrail, not OS isolation: opaque scripts, other processes under the same user, and installer internals may bypass command recognition. Matching hooks can start concurrently; denial by one hook does not prevent another hook from observing the event or sending telemetry. Do not claim absolute write or data-flow isolation from links, instructions, or a Hook.

Stop for an explicit decision before choosing conflicting semantics, expanding permissions or network destinations, changing managed/native lifecycle contracts, retiring an incompatible package, or publishing restricted content. Ordinary content checks do not authorize external sends, production changes, Hook trust, or privilege changes.

## Acceptance and implementation sequence

Acceptance must establish the following independently:

- **Source:** one accepted editable package, exact version evidence, license review, and no runtime/credential leakage into Git.
- **Filesystem:** correct links or views, matching content/modes, no independent native source drift, and preservation of unresolved originals.
- **Lifecycle:** repeatable install/update/uninstall, drift refusal, safe rollback, concurrency checks, and recoverable interrupted phases.
- **Runtime:** native discovery and the intended entry/policy in a new process for each supported client.
- **Execution:** a small authorized real invocation with the expected resources and tools. Loading a name is not this proof.

The initial [optional module](../extensions/skill-source-management/README.md) implements inspection, staging, guarded publication, owned bindings, withdrawal, receipts and selective rollback for standalone packages. Native fixtures validate Codex discovery and Claude body injection in fresh temporary Homes. This does not establish production business execution, universal client support or cross-platform lifecycle support. The machine-specific reference manager and private packages are not imported.

The optional module is the initial CLI/adapter package. Extend it only with separately verified client and filesystem strategies, without importing personal inventory or hard-coded installation paths. Keep existing `/v1` and `/mcp` configuration schemas unchanged. A DSH management view, periodic update orchestration, and additional platform adapters are P1. Hosted multi-user source distribution and strict OS write isolation are P2, not prerequisites for local sharing.

## References

Discovery and format references, checked on 2026-11-17:

- [Agent Skills format](https://agentskills.io/specification)
- [Codex local Skill discovery](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)
- [Claude Code Skills and host-specific extensions](https://code.claude.com/docs/en/skills)

Client documentation is a starting point for adapters, not a substitute for checking the installed runtime. Shared bytes preserve source identity, not identical model decisions, credentials, or behavior.
