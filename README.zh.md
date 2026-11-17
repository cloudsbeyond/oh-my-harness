# oh-my-harness

[English](README.md)

一个 harness 能调用模型后，通常还得分别接入各家供应方的搜索、图像、文档和语音接口。以搜索为例，Codex 通过 Responses 返回工具动作，Kimi 通过 Messages 返回服务端搜索结果。每个客户端都接一遍，就要反复处理路由、请求参数和结果格式。

oh-my-harness 把不同来源的能力封装成与 provider 解耦的执行层。MCP 工具是兼容入口之一；原生宿主插件可以不经 MCP 调用同一能力层。[能力契约与 DSH 集成中的设计思考](docs/capabilities.md)。以 DSH 为例，会话可以用 Kimi 推理，联网查询则调用 Codex 提供的 `web_search` 并取得来源。CLIProxyAPI/MCP 方案通过 CLIProxyAPI 使用已授权的账号，包括已经订阅的付费 Agent 服务。独立 harness 暴露的工具也可以作为能力来源，通过适配器直接接入 Capability Proxy。这条扩展路径需要实现对应的适配器。 [架构说明](docs/architecture.md)

![HTTPS 接入层分别转发模型和 MCP 请求，Capability Proxy 通过 CLIProxyAPI 调用上游，紫色虚线表示直连独立 harness 的扩展路径。](docs/architecture.png)

实线表示 CLIProxyAPI/MCP 部署方案的路由。紫色虚线表示独立 harness 的扩展路径。

## 原生 Desktop DSH 插件包

已有 DSH **0.2.2-rc.3** 和模型 API 时，在插件管理器中安装本地仓库根目录，再按[原生插件配置说明](extensions/dsh-capabilities/README.md)设置宿主凭据引用、provider 和各能力的默认路由。图片、文档、视频和语音工具直接调用能力核心，不需要启动 MCP 服务或手工复制文件。搜索接入 DSH 已有的 web provider 菜单，HTTP 抓取保持独立。根包提供文档预览页中的 WAV 播放器；[可选语音输入包](extensions/dsh-voice-input/README.md)通过已有 speech-to-text 服务把录音转写后回填草稿，不自动发送。真实麦克风权限和浏览器播放仍需 App 验收；不把源码测试当成视觉验证。

下面的 CLIProxyAPI/MCP 方案仍是兼容入口，不是使用上述原生插件的前置条件。

## 通过 MCP 用 DSH 跑通

安装 Node.js 24+，将 CLIProxyAPI v8.0.51 的 `cli-proxy-api` 程序放到 PATH。 [CLIProxyAPI 发布页](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.51)

```sh
npm ci
npm run init
npm run proxy -- -codex-device-login
npm run proxy -- -kimi-login
```

如果只准备授权一个账号，初始化时用 `npm run init -- --provider codex` 或 `--provider kimi`，只执行对应的登录命令。

在两个终端分别运行 `npm run proxy` 和 `npm start`。第一个启动 Model Proxy，第二个启动 Capability Proxy。再从另一个终端检查入口并打开 DSH。

```sh
npm run doctor -- --models
npm run doctor
npm run dsh
```

`npm run dsh` 启动独立的 DSH Web 配置和工作区。在会话中试用 `mcp__gateway__web_search`，例如请它查询 MCP 的传输方式并列出来源。模型 ID 如果与账号可用的模型不符，根据 `doctor -- --models` 输出调整 `.state/config.json`。工具调用的结果用于验证上游能力。

快速开始通过 MCP 调用工具。如需在 GPT 模型对话中直接获得原生搜索引用和生成图，可在 DSH 主机上安装可选的 Codex 适配器，在 Web profile 中启用，并从它注册的供应方中选择 GPT 模型。 [可选 DSH Codex 扩展](extensions/dsh-native-codex/README.md)

| 本地入口 | 地址 | 密钥文件 |
| --- | --- | --- |
| Model Proxy | `http://127.0.0.1:8317/v1` | `.state/model.key` |
| Capability Proxy | `http://127.0.0.1:8318/mcp` | `.state/gateway.key` |

## 接入其它 harness 或 agent

把兼容的模型客户端指向 `/v1`，把 Streamable HTTP MCP 客户端指向 `/mcp`，分别使用对应密钥。只消费工具的客户端只需要 MCP 地址和能力密钥。DSH 的本地文件适配器把工作区文件转换成 MCP 请求，其它客户端可直接按 MCP 工具 schema 传 Base64。

托管部署时，在自管服务器上用一个 Caddy 或 NGINX 接入层处理 HTTPS，按 `/v1` 和 `/mcp` 分流。两个入口可以共用域名，也可以用独立域名，后端保持回环监听。 [架构与凭据边界](docs/architecture.md) · [部署说明](docs/deployment.md) · [供应方配置和工具](docs/providers.md)

`npm test` 使用本地模拟上游检查路由、密钥隔离、MCP 工具和文件适配器。

[DSH 集成：代码、设计取舍与验证](docs/dsh-integration.md) · [Codex Native 扩展与可复现构建](extensions/dsh-native-codex/README.md)

[MIT License](LICENSE)
