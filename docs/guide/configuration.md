# 配置指南

## LLM 配置

Actspan 兼容提供 OpenAI Responses API 格式的 LLM 服务。配置入口在扩展的 **Options 页面**（右键扩展图标 > 选项）。

### 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| API Endpoint | 完整的 LLM API 请求地址 | `https://ai-api-gateway.app.baizhi.cloud/api/openai/v1/responses` |
| API Key | 你的 API 密钥 | - |
| Model | 使用的模型名称 | `gpt-6.1-sol` |

配置存储在 `chrome.storage.local` 中，key 为 `actspan_ai_settings`。

### 支持的模型/服务

Actspan 理论上支持任何提供 OpenAI Responses API 兼容接口的服务：

| 服务 | Endpoint 示例 | 说明 |
|------|---------------|------|
| OMP anyrouter | `https://ai-api-gateway.app.baizhi.cloud/api/openai/v1/responses` | 当前 OMP Codex 风格 Responses 服务，默认模型 `gpt-6.1-sol` |
| OpenAI | `https://api.openai.com/v1/responses` | 官方服务 |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai/deployments/{model}/v1/responses` | Azure 托管 |
| 国内中转 | 服务商提供的完整 endpoint | 兼容 OpenAI Responses API 的中转服务 |
| Ollama | `http://localhost:11434/v1/responses` | 本地部署 |
| LM Studio | `http://localhost:1234/v1/responses` | 本地部署 |

::: warning 注意
Actspan 依赖 LLM 的 **Function Calling（工具调用）** 能力。请确保你使用的模型支持此功能，否则 AI 将只能进行纯文本对话，无法执行浏览器操作。
:::

## 工作流管理

在 Options 页面可以管理站点工作流：

- **查看** - 浏览已安装的工作流列表（内置 + 用户自定义 + 远程同步）
- **添加** - 粘贴 JSON 定义添加自定义工作流
- **删除** - 移除用户自定义或远程同步的工作流（内置工作流不可删除）
- **启用/禁用** - 控制工作流是否对 AI 可见
- **Manifest 源管理** - 添加、删除远程 Manifest URL，手动触发同步

## 动态工具

除了内置工具和站点工作流，Actspan 还支持**动态工具**（Dynamic Tools），即通过 HTTP 远程调用的自定义工具。

### 动态工具配置

每个动态工具需要以下配置：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 工具名称（小写字母、数字、下划线） |
| `description` | string | 是 | 工具描述（AI 据此判断是否调用） |
| `parameters` | object | 是 | JSON Schema 格式的参数定义 |
| `endpoint` | string | 是 | HTTP 接口地址 |
| `method` | string | 否 | HTTP 方法（默认 `POST`） |
| `headers` | object | 否 | 自定义请求头 |
| `timeoutMs` | number | 否 | 超时时间（默认 15 秒，最大 60 秒） |
| `enabled` | boolean | 否 | 是否启用（默认 `true`） |

动态工具也支持通过 Manifest URL 批量导入。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+M` / `Ctrl+M` | 唤起/关闭 AI 搜索框 |

::: tip 提示
快捷键在所有网页上生效。如果与某个网页的快捷键冲突，可以通过悬浮球点击唤起。
:::
