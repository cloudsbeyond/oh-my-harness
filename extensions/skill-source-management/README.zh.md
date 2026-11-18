# Skill 资产管理与宿主接入

[English](README.md) · [设计与边界](../../docs/skill-source-management.zh.md)

本模块把已审查的用户级独立 Skill 发布到 `~/.agents/skills`，维护 Codex 和 Claude Code 的接入记录，使多个 Agent 共用一个实体源。它不进入模型代理、MCP 或 DSH 的运行链路，不把 Skill 变成工具接口。

初版使用 Python 3.11+ 标准库，无额外 Python 依赖。内容检查可跨平台运行；安装、更新、链接和回滚目前仅支持 **macOS**，使用 Darwin 的排他重命名和原子目录交换。尚未实现 Linux、Windows 的生命周期写入。

它不是现有本机管理器的无缝替代。遇到外部或旧格式注册表会拒绝操作，且不初始化新状态。不要把演示直接运行到已有安装上；迁移须单独审查。

## 快速试用

在仓库根目录使用 `npm run skills -- --help`，或者直接运行 `python3 extensions/skill-source-management/manage.py --help`。完整可运行的临时 Home 示例见 [英文说明](README.md#try-it-in-an-empty-temporary-home)。该示例不会写入真实用户目录。

基本顺序是：

1. `stage` 将完整本地候选复制到发现路径之外，记录来源、明确的版本或提交证据及摘要。它不执行远程获取或安装脚本。
2. 查看候选的 `SKILL.md`、脚本、资源和许可，使用 `inspect` 核对摘要。摘要校验不能代替内容、安全或许可审查。
3. `install` 携带 `--expect-source` 接受候选。`update` 还必须携带 `--expect-current`，并保留旧包。
4. `bind` 建立客户端接入，`verify --receipt` 检查操作收据，`audit` 检查受管对象及所选目录中的可见非受管入口。
5. 用新客户端进程确认实际发现。业务工具执行仍需按客户端权限单独验证。

`--home`、`--source-root`、`--state-root` 放在子命令之前。Home 必须存在，源和状态须处于 Home 内且不重叠，也不能与原生技能发现目录重叠。每个源根使用一个私有状态根；同状态根的管理器进程通过有界锁串行写入。这不隔离同一用户下的任意外部程序。

## 两个客户端的差别

| 客户端 | 默认接入方式 | 解除接入的效果 |
| --- | --- | --- |
| Codex | 直接扫描 `~/.agents/skills`，不另建 `~/.codex/skills` 副本 | `unbind` 仅移除本管理器的记录，返回 `discovery_still_active: true`，**不关闭原生发现** |
| Claude Code | 在 `~/.claude/skills/<name>` 建相对软链 | `unbind` 移除受管软链，原链保留在收据目录，中央源不变 |

显式指定其他源根时，Codex 也使用原生技能目录软链。已有实体或不归本管理器所有的链接会阻止接入，不自动覆盖。

发布到 Codex 的默认源根可能在 `bind` 前就被发现。若要停止发现，可解除接入后用 `uninstall` 撤回源，或者另行授权修改客户端原生开关。本模块不修改该开关。共享文件不能保证各 Agent 具有相同触发策略、工具权限或模型结果。

## 管理范围与数据

正式源位于 `<home>/.agents/skills/<name>`，源注册表使用 `omh-skill-sources-v1`，只包含来源、版本和许可证据、声明名称、摘要。客户端路径、接入历史、候选和操作收据位于 `<home>/.agents/skill-management`，不进入源 Git。

`unbind` 只解除受管接入；`uninstall` 在解除接入并检查已知客户端消费者后撤回源，旧包留在收据中。`rollback` 根据收据、当前内容和操作历史选择性恢复，不覆盖同目标的后续编辑，也不撤销其他 Skill 的后续安装。

Git 由操作者手动管理。本模块不会初始化仓库、暂存、提交或推送。开源模块不携带用户的真实 Skill 清单、私有包、凭证或运行时数据。元数据在选取文件目标前会校验，但没有签名，不能防御 Home 所有者的任意篡改。

## 失败恢复与限制

- 同一 Skill 有中断收据时，后续发布和接入变更会被阻止，直到受保护回滚或人工恢复。盘点会列出这些收据，不报成干净状态。撤回源前还会检查受支持原生目录下所有软链，包括不同名称的别名，但不扫描未支持的客户端或任意文件引用。
- 收据为 `published` 时，文件系统发布已完成，但元数据可能部分写入。先 `verify` 查看实际源、注册表和保留包事实，再尝试受保护的回滚。
- `preparing`、`publishing`、`reversing`、`reversed` 阶段中断需要**人工核对恢复**，不要盲重试。目录操作与多个 JSON 文件不是一个整体的崩溃原子事务。
- 检查摘要覆盖路径、对象类型、权限位、文件字节和包内相对链接；拒绝越界链接、常见凭证或运行环境文件、原生插件标记及嵌套 `SKILL.md`。忽略 Git 和 Python 等开发缓存。
- 单包上限为 64 MiB、10,000 个对象，入口须是最大 1 MiB 的真实 UTF-8 `SKILL.md`。这只是最小元数据提取器，不是完整 YAML/Agent Skills 规范验证器，也不是完整秘密扫描器。
- `audit` 的 `verified` 只说明受管对象通过检查，不等于整机所有目录、内置技能、插件、其他 Agent 或实际业务执行通过检查。
- 完整插件与缓存适配、TRAE 入口、远程获取、Hook 拦截和信任、原生启停策略、Git checkpoint、严格 OS 隔离均后置。不要把插件拆成多个独立 Skill 以绕过这个边界。

## 验证

```sh
npm run test:skills
npm test
OMH_SKILL_NATIVE_TESTS=1 npm run test:skills
```

原生测试从 PATH 找客户端，也可设置 `OMH_CODEX_BIN`、`OMH_CLAUDE_BIN`。未安装的客户端会跳过对应测试。所有阶段使用生成的临时 Home、独立进程和本地虚拟凭证。

Codex 仅调用 app-server 的 `skills/list`，不启动模型回合。Claude 对回环地址的 Anthropic 协议夹具调用无害测试 Skill，检查实际发出的请求在安装、更新、回滚后包含中央正文，解除接入后不再包含。这验证加载和正文注入，不验证真实模型判断或业务工具执行；不绕过 Hook 信任或托管安全策略。

## 开发与贡献

本模块遵循仓库根目录的 [MIT 许可](../../LICENSE)，不改变被管理 Skill 的第三方或私有许可。修改前先确定其影响的是独立包生命周期还是客户端运行时；不要把插件、Hook 或账号授权引入当前管理器。

提交须附对应的隔离回归测试，使用临时 Home，不读写维护者的真实安装。默认测试无需 Agent 账号或 API 凭证。CI 在 macOS、Linux、Windows 的 Python 3.11 和 3.14 上运行；macOS 验证生命周期，其他平台验证只读检查及写入拒绝。原生客户端验证仍需本地显式启用，CI 不安装客户端，也不配置 provider 凭证。

公开包只包含源码、测试和通用文档，不包含本机执行计划、交付记录、候选、收据或运行状态。
