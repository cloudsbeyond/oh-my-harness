# oh-my-harness

[English](README.md)

**专注 harness 的集成与适配：复用已授权的外部能力和版本化 Skill，编排、会话与权限仍由宿主掌握。**

## 为什么需要这个项目

一个 harness 已经能规划任务、调用模型，仍可能无法使用搜索、生图、文档理解或语音。用户购买的 Agent 订阅可能提供这些能力，但它们有自己的协议和执行方式。接通文本生成接口，不会自动把工具事件、引用、附件和文件交付接入另一个 harness。

缺少的是集成。不同能力来源的输入和结果不同，宿主又有各自的凭据、文件权限、生命周期和界面。每个 provider、每个 harness 都重做这些接入，会让任务流程绑定供应商，也会反复实现相同的适配逻辑。

Skill 复用在另一个阶段面对类似问题。将同一份 Skill 复制到多个 Agent 中，可以暂时使用，却形成多份可编辑源码，版本和更新历史逐渐不清楚。即使共享源码，也仍需适配各宿主的发现规则，并保留它们自己的执行权限。

oh-my-harness 处理这些接入边界，让既有 harness 复用已授权的外部能力和经过审查的 Skill 资产，同时继续负责规划、会话与判断。DSH 是主要集成和验收宿主；MCP、独立核心 API 和已支持的发现适配也服务其它 harness。

## 三类集成如何构成整体

![宿主持有编排，分别接入独立能力、主模型原生语义和 Skill 发现。](docs/architecture.png)

| 集成职责 | 解决的问题 | 实现 |
| --- | --- | --- |
| 独立能力调用 | 执行有明确边界的操作，不与会话模型绑定 | Capability Core、provider driver、MCP 与宿主 Native adapter |
| 主模型原生语义 | 保留主模型响应中的搜索/生图事件及后续回放 | DSH Codex model-native adapter |
| Skill 资产与发现 | 保持一份已接受源码、版本证据、受保护更新与宿主发现 | 可选 Skill Source Manager |

划分依据是执行语义。独立生图工具产生一次独立结果；模型流中的生图已经执行，适配器应保留其结果，而不是再执行一次。Skill 则是由宿主决定何时使用的指令与资源资产，不是另一种 provider 操作。把三者都塞进 MCP 或同一个服务，会丢失这些差别。

MCP 和 Native 插件在各自部署中复用同一套能力核心代码，不要求访问同一个远程 Runtime。Skill 管理独立于请求运行。[组件部署与凭据边界](docs/architecture.md)

## 复用能力，不绑定会话供应方

DSH 会话可以用 Kimi 推理，用另行配置的 Codex provider 搜索或生图；文档操作也可以交给应用自行接入的本地解析器。harness 选择操作并判断结果，适配器处理来源特定的协议与输出映射。

Hosted 示例区分两个职责：

| 职责 | 负责什么 | 客户端接口 |
| --- | --- | --- |
| Model Proxy | 模型推理、目录访问与上游路由 | CLIProxyAPI 示例中的 `/v1` |
| Capability Proxy | 使用执行核心，通过 MCP 提供独立能力操作 | `/mcp`，使用独立客户端密钥 |

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 是外部模型代理实现，可以复用用户在其中授权的账号，包括付费 Agent 订阅。它不等于能力核心，也不是 Native provider 集成的前提。会话可以继续使用已有兼容模型服务；只调用工具的客户端只需能力入口。独立 harness 也可以通过专用适配器作为能力来源，但项目并未为每种服务预置连接器。

已有订阅不代表任意操作都可用，仍需核对账号、模型、协议和真实结果。远程访问使用 HTTPS 域名路由，同机部署可以使用回环。[部署方式](docs/deployment.md)

## 设计方法

项目通过解决具体的 harness 接入问题扩展，而不是为每个 provider 功能新增一个工具名：

1. **从操作和已有所有者出发。** 复用宿主凭据、文件、搜索、语音和预览。适配器补足缺失能力，不另做规划器或权限系统。
2. **先选边界，再做实现。** 已有操作通常只需配置或新增 provider driver；新宿主需要交付/发现适配；主模型事件需要流与回放处理。
3. **跨边界保留语义。** 保留可归因来源、原始媒体、明确的 provider 选择和版本证据。定义取消、错误和回滚，不静默更换来源或重复已完成工作。
4. **分阶段验证用户能获得的结果。** 配置、发现、执行和交付是不同观察。夹具通过或工具可见，不代表真实宿主行为已经通过。

[能力契约与设计理由](docs/capabilities.md) · [扩展决策](docs/providers.md#extension-workflow) · [DSH 集成方法](docs/dsh-integration.md) · [Skill 设计](docs/skill-source-management.zh.md)

## 已有 DSH：接入原生能力

针对 **DSH 0.2.2-rc.3**，先运行 `npm ci`，在插件管理器中安装本地仓库根目录，再配置[宿主凭据引用与操作默认值](extensions/dsh-capabilities/README.md)。插件可直接调用兼容 provider API，不要求 MCP 服务或 CLIProxyAPI。

插件接入宿主搜索与附件流程，包含文档页 WAV 预览；[可选语音输入](extensions/dsh-voice-input/README.md)负责麦克风转录回填草稿。若要在 GPT 主模型对话内保留搜索引用、图片与回放，使用独立的 [Codex model-native adapter](extensions/dsh-native-codex/README.md)。添加独立能力不会迁移主模型路由。

## 通过 MCP 用 DSH 跑通

安装 Node.js 24+，将 [CLIProxyAPI v8.0.51](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51) 的 `cli-proxy-api` 程序放到 PATH。这个示例启动隔离的 DSH Web profile：

```sh
npm ci
npm run init
npm run proxy -- -codex-device-login
npm run proxy -- -kimi-login
```

只接入一个账号时，用 `--provider codex` 或 `--provider kimi` 初始化，并只执行对应登录命令。在两个终端分别运行 `npm run proxy` 和 `npm start`，然后执行：

```sh
npm run doctor -- --models
npm run doctor
npm run dsh
```

根据上游调整 `.state/config.json` 中的模型 ID 和容量，再让 `mcp__gateway__web_search` 查询一个需要来源的问题，检查实际结果。[端点、密钥文件与其它客户端](docs/deployment.md)

## Skill 资产与宿主发现

[Skill Source Manager](extensions/skill-source-management/README.zh.md)保留来源和版本证据，为独立 Skill 提供经过审查的发布、更新、接入和回滚。当前提供 Codex／Claude Code 发现适配，生命周期写入需要 Python 3.11+ 和 macOS。

正式源和私有操作记录保存在本 checkout 外。共享源码不会统一各 Agent 的工具、权限或模型行为，管理器也不会自动替换用户已有的安装系统。[设计与生命周期边界](docs/skill-source-management.zh.md)

## 验证与源码归属

```sh
npm test
npm run test:skills
npm run verify:package
```

上述命令覆盖隔离的核心/适配行为、Skill 生命周期和实际分发内容。原生 SDK 构建、新进程宿主发现、付费上游调用及浏览器验收分别有自己的前置条件。[版本证据与未完成检查](docs/verification/dsh-0.2.2-rc.3.md)保留这些区分，包括尚未完成的真实播放和麦克风验收。

公开源码保存可复用实现、示例和测试；实际端点、凭据、个人 Skill、收据、会话和任务产物保存在私有环境。[MIT License](LICENSE)
