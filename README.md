<p align="center">
  <img src="public/actspan-logo.svg" width="128" height="128" alt="Actspan Logo">
</p>

<h1 align="center">Actspan</h1>

<p align="center">
  <strong>在真实浏览器里完成多步骤任务的开源 AI 助手。</strong>
</p>

<p align="center">
  用自然语言搜索网页、操作页面、提取信息、填写表单，并把结果带回来。
</p>

<p align="center">
  中文 | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/youxing-max/ActSpan/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License">
  </a>
</p>

---

Actspan 是一个运行在 Chrome 中的 AI 浏览器助手。你只需要描述目标，它会在后台拆解任务、调用浏览器工具、访问多个网站、整理结果；需要确认的高风险操作会停下来等待你的确认。

它不是只会回答问题的聊天窗口，而是让 AI 在你的浏览器环境中完成实际工作的执行层：使用你已经登录的页面，处理真实的 DOM 和网络请求，并把过程和结果留在当前浏览器里。

## 适合什么场景

- **信息调查**：跨站搜索、阅读页面、提取表格和关键字段，整理成结构化结果。
- **重复操作**：打开网站、筛选内容、复制数据、截图、下载文件或填写表单。
- **站点自动化**：把常用任务保存为工作流，之后用一句话再次运行。
- **团队通知**：调查完成后，将结果摘要推送到已配置的飞书 / Lark 或钉钉机器人 Webhook。
- **本地与自定义能力**：连接你选择的模型服务，或通过 MCP 和动态工具扩展能力。

## 核心能力

### 在真实浏览器中执行

Actspan 直接运行在 Chrome 扩展环境中，复用当前浏览器已有的登录态。无需迁移 Cookie，也无需为每个站点重新登录；AI 可以在你授权的页面上读取内容、点击、输入、导航和截图。

### 自然语言驱动的 Agentic Loop

输入目标后，后台 Agentic Loop 会根据上下文选择工具并进行多轮执行。代码负责权限、边界、任务隔离和消息传输，模型负责理解目标、选择下一步动作和整理结果。

### 录制并复用工作流

演示一次浏览器操作即可录制任务。Actspan 会清理录制过程中的噪声，生成可复用的工作流；工作流使用声明式 JSON 描述，不需要为每个站点编写完整扩展代码。

### 工具与协议扩展

- 页面操作、导航、标签页、截图、DOM/CSS、存储和网络诊断等浏览器工具。
- 基于 MCP 的标准化工具注册与调用。
- 支持动态 HTTP 工具和远程 Manifest，可按需接入已有服务。
- 支持飞书 / Lark、钉钉机器人 Webhook，用于推送任务完成结果和其他通知。

### 模型由你选择

兼容 OpenAI API 格式的模型服务，包括云端服务和本地部署的 Ollama、LM Studio 等。API Endpoint、API Key 和模型名称由你配置，项目不要求绑定特定模型提供商。

## 隐私与安全边界

- 扩展和浏览器自动化逻辑在本地 Chrome 中运行。
- 请求会发送到你在 Options 页面配置的模型 Endpoint；Actspan 不代管你的模型服务。
- 页面内容、登录态和工具权限应按任务需要使用。不要向不可信模型或工具开放敏感页面。
- 涉及敏感操作时，Actspan 支持人机确认；你可以在执行前检查并拒绝动作。
- API 配置保存在 Chrome 本地存储中，不需要额外的 Actspan 账号。

## 快速开始

### 直接安装发布版本

1. 打开[下载页面](docs/download.md)，下载最新的扩展压缩包。
2. 解压文件，在 Chrome 地址栏打开 `chrome://extensions/`。
3. 开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `actspan-extension/` 文件夹。
4. 右键点击 Actspan 扩展图标，打开**选项**，填写模型 Endpoint、API Key 和 Model。
5. 打开任意网页，按 `Ctrl+M`（Windows/Linux）或 `Cmd+M`（macOS）唤起助手。

### 从源码构建

```bash
git clone https://github.com/youxing-max/ActSpan.git
cd ActSpan
npm install
npm run build
```

构建完成后，在 Chrome 中加载 `build_version/actspan-extension/`。完整安装和配置说明见[快速开始指南](docs/guide/getting-started.md)。

## 使用示例

打开任意网页后，可以直接输入：

```text
这个页面讲了什么？请列出关键结论和证据。
在当前网站搜索符合条件的商品，整理前 5 个结果。
读取这份表格，提取姓名、邮箱和金额，导出成结构化列表。
调查完成后，把结果摘要推送到“调查结果群”。
```

## 工作原理

```text
你的目标
   ↓
后台 Agentic Loop：理解任务 → 选择工具 → 执行与校验 → 整理结果
   ↓
浏览器页面 / 工作流 / MCP 工具 / Webhook
   ↓
悬浮球、会话记录和通知
```

Actspan 使用 Chrome Extension Manifest V3 的分层架构：

| 层 | 职责 |
|---|---|
| Content Script | 悬浮球 UI、页面交互和页面侧事件 |
| Background | AI 编排、任务生命周期、工具调度和通知 |
| Channel | Content Script、Background 与外部 MCP 之间的消息通信 |

## MCP 与外部工具

项目包含本地 MCP Server，可把 Actspan 的浏览器能力暴露给支持 MCP 的客户端。稳定工具共 34 个，统一使用 `actspan_` 前缀：

| 分组 | 工具 | 说明 |
|---|---|---|
| **状态与通知** | `actspan_status` | 桥接连接状态，先调它排查连接 |
| | `actspan_status_update` | 用一句话向用户播报即将执行的动作，即时返回 |
| | `actspan_feishu_push` | 向已启用的飞书/Lark 或钉钉 Webhook 推送通知 |
| **标签页** | `actspan_tabs_list` | 列出当前任务 lease 内的标签页 |
| | `actspan_tabs_select` | 把任务持有的标签页设为活动标签页 |
| | `actspan_tab_open` | 后台打开标签页，默认不抢焦点 |
| | `actspan_tab_close` | 关闭当前任务打开的标签页 |
| | `actspan_tab_navigate` | 让任务持有的标签页跳转 URL |
| **页面读取** | `actspan_page_snapshot` | 返回带 ref 的语义快照，覆盖 shadow DOM 与 iframe |
| | `actspan_page_read` | 读取页面文本/HTML，可按 selector、ref 或 find 取单个元素 |
| | `actspan_screenshot` | 通过 CDP 截图 |
| **页面操作** | `actspan_page_click` | 按 selector/ref/find 点击，合成事件无效果时自动升级为真实 CDP 输入 |
| | `actspan_page_type` | 输入文本，提交/支付类目标不自动升级 |
| | `actspan_page_eval` | 执行可证明无副作用的 JS 表达式 |
| | `actspan_page_select` | 选择原生 select 的值或精确选项文本 |
| | `actspan_page_upload` | 用 base64 写入文件输入或派发拖放到 dropSelector |
| | `actspan_page_key` | 按顺序按键（Tab 移焦、Enter 激活），不触达支付目标 |
| | `actspan_page_wait` | 等待 selector、页面文本或 DOM 空闲稳定 |
| | `actspan_page_scroll` | 按像素滚动，不激活也不聚焦标签页 |
| **批量与复用** | `actspan_act` | 复合动作，一次调用批量执行可预测步骤（默认操作方式） |
| | `actspan_adopt` | 把成功的 act 草稿沉淀为已保存工作流 |
| **网络** | `actspan_network_list` | 列出最近完成的请求，不含响应体与凭证 |
| | `actspan_network_detail` | 查看单个请求，可选读取 50 KB 响应体 |
| | `actspan_network_query` | 读取匹配 URL 的最新响应体，按 index 回溯更早批次 |
| **数据** | `actspan_data_fetch` | 抓取页面或二进制数据，可流式写入 savePath |
| | `actspan_data_paginate` | 有界翻页抓 JSON，返回停止原因与摘要 |
| | `actspan_data_download` | 经 `chrome.downloads` 下载 URL、文本或截图 |
| **技能与工作流** | `actspan_skills_list` | 列出 skill 摘要与 registry 版本 |
| | `actspan_skill_detail` | 读取 skill 全文与结构化工作流契约 |
| | `actspan_workflow_run` | 启动结构化工作流，返回异步任务句柄 |
| **Agent 任务** | `actspan_agent_submit` | 提交开放式浏览器任务，返回异步任务句柄 |
| | `actspan_agent_status` | 按 taskId 查询任务状态 |
| | `actspan_agent_result` | 读取任务保留的结果 |
| | `actspan_agent_cancel` | 按 taskId 取消任务 |

MCP 配置、鉴权、工具参数和端到端测试见 [MCP Bridge 文档](MCP-BRIDGE.md)。

## 文档

- [文档首页](docs/index.md)
- [快速开始](docs/guide/getting-started.md)
- [使用示例](docs/guide/examples.md)
- [工作流指南](docs/guide/workflows.md)
- [配置指南](docs/guide/configuration.md)
- [MCP Bridge](MCP-BRIDGE.md)

## 开发

```bash
npm run dev          # 监听构建
npm run build        # 构建 Popup、Content、Sidepanel 和 Background
npm test             # 运行 Node 测试
npm run lint         # 代码检查
npm run docs:dev     # 本地预览文档站
```

## 许可证

[AGPL-3.0](LICENSE)
